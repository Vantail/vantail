#!/usr/bin/env node
/**
 * Publish a release to npm.
 *
 * Kept out of the workflow file so it can be dry-run locally: a release script
 * that has only ever executed on a tag push is a release script nobody has
 * tested.
 *
 *   node scripts/publish.mjs --dry-run
 *   node scripts/publish.mjs --packages dist-packages
 *   node scripts/publish.mjs --registry https://example.com --partial
 *
 * Packages go wherever `@vantail:registry` points, which is set in `.npmrc`
 * rather than here. Releases go to npmjs; nothing infers that from a package
 * name.
 *
 * Order matters. The platform binaries go first, because `@vantail/runtime`
 * declares optional dependencies on them and npm resolves those at install
 * time - publishing the resolver first leaves a window where installing it
 * fails.
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runtimeBuilds } from "./lib/runtime-builds.mjs";
import { isVersion } from "./lib/runtime-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const platformPackages = resolve(flag("packages", "dist-packages"));

/**
 * Whether the registry already has this package at this version.
 *
 * Only asked on the path that reuses an older release's binaries, where
 * naming a package that was never published makes the whole install fail.
 */
function publishedAt(name, version) {
  const args = ["view", `${name}@${version}`, "version"];
  const registry = flag("registry");
  if (registry) args.push("--registry", registry);
  const userconfig = flag("userconfig");
  if (userconfig) args.push("--userconfig", userconfig);

  try {
    const out = execFileSync("npm", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Publish a subset, by package name.
 *
 * For adding a package to a version that is already out, or re-sending one
 * that failed - the manifest rewriting has to happen either way, so doing it
 * by hand is how a `workspace:` range reaches a registry verbatim.
 */
const only = flag("only", undefined)
  ?.split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const wanted = (name) => !only || only.includes(name);
const version = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
).version;

/**
 * Where the packages go.
 *
 * Passed explicitly to every `npm publish` rather than left to npm's scope
 * resolution, so a registry is never inferred from a package's name.
 */
function configuredRegistry() {
  const explicit = flag("registry", undefined);
  if (explicit) return explicit;

  const npmrc = join(root, ".npmrc");
  const where = existsSync(npmrc) ? ["--userconfig", npmrc] : [];

  for (const key of ["@vantail:registry", "registry"]) {
    const value = execFileSync("npm", ["config", "get", key, ...where], {
      encoding: "utf8",
    }).trim();
    if (value && value !== "undefined" && value !== "null") return value;
  }

  // No silent fallback: an unconfigured machine would otherwise default to
  // the public registry, which is exactly the accident this must not have.
  console.error(
    "No registry configured.\n\n" +
      "Set one in .npmrc:\n" +
      "  @vantail:registry=https://your-registry.example\n\n" +
      "or pass --registry <url>.",
  );
  process.exit(1);
}

const isPublicNpm = (url) =>
  /(^|\/\/)registry\.npmjs\.(org|com)(\/|$)/.test(url);

const registry = configuredRegistry();

// A publish to npmjs cannot be undone. The unpublish window is short, and the
// version number is burned for good either way. It is also easy to reach by
// accident, since npmjs is where npm goes when nothing says otherwise - a
// missing .npmrc or a stray scope setting is all it takes. So the release
// workflow says it means it, and a stray local run does not.
if (
  isPublicNpm(registry) &&
  !process.argv.includes("--i-mean-it-publish-publicly")
) {
  console.error(
    `Refusing to publish to ${registry}.\n\n` +
      "Publishing there is permanent. If that is genuinely intended, pass\n" +
      "--i-mean-it-publish-publicly.",
  );
  process.exit(1);
}

const publicNpm = isPublicNpm(registry);

/**
 * Which dist-tag the published versions answer to.
 *
 * A prerelease must not become `latest`, or every `npm install` picks it up.
 * Defaults to `dev` for a prerelease version and `latest` otherwise, so the
 * common cases need no flag and getting it wrong takes effort.
 */
const tag = flag("tag", version.includes("-") ? "dev" : "latest");

/**
 * The version `@vantail/runtime` should depend on its platform packages at.
 *
 * Normally the version being published - they go out together. A dev build
 * publishes only the JavaScript, so it points at the last release's binaries
 * instead, which are the ones that exist.
 */
const runtimeVersion = flag("runtime-version", undefined);

if (runtimeVersion !== undefined && !isVersion(runtimeVersion)) {
  // This value becomes the version every platform package is depended on at.
  // Anything that is not a version is an install failure for every user, and
  // it has happened: `[object Object]` was published once and then read back
  // and re-published by the release after it.
  console.error(
    `--runtime-version is ${JSON.stringify(runtimeVersion)}, which is not a version.`,
  );
  process.exit(1);
}

/**
 * npm reads a project `.npmrc` from the working directory only - it does not
 * walk up - and every publish here runs with `cwd` set to a package. Pointing
 * `--userconfig` at the checkout's `.npmrc` is what carries the registry
 * credentials into those directories.
 *
 * It also narrows what the publish can reach: npm stops reading `~/.npmrc`,
 * so whatever tokens are in there are not in scope for this process.
 */
const projectNpmrc = join(root, ".npmrc");
const AUTH = existsSync(projectNpmrc) ? ["--userconfig", projectNpmrc] : [];

// `--access` and `--provenance` are registry.npmjs.org features, so a
// third-party registry gets neither.
//
// Provenance additionally needs a CI environment npm can attest from: it
// signs with an OIDC token, and asking for it anywhere else is a hard error
// rather than a warning. That matters for the first publish of a package,
// which cannot use trusted publishing and so has to happen from someone's
// machine with a token.
const provenance = publicNpm && process.env.GITHUB_ACTIONS === "true";

const PUBLISH = [
  "publish",
  "--registry",
  registry,
  "--tag",
  tag,
  ...AUTH,
  ...(publicNpm ? ["--access", "public"] : []),
  ...(provenance ? ["--provenance"] : []),
];

/** Publishing order: dependencies before the things that depend on them. */
const WORKSPACE_ORDER = [
  "packages/shared",
  "packages/api",
  "packages/runtime",
  "packages/vite",
  "packages/cli",
  "packages/create",
];

function run(command, args, options = {}) {
  if (dryRun) {
    console.log(`  would run: ${command} ${args.join(" ")}`);
    return "";
  }
  return execFileSync(command, args, { stdio: "inherit", ...options });
}

// ---------------------------------------------------------------------------
// Checks that are cheaper to fail than to undo
// ---------------------------------------------------------------------------

console.log(`Publishing ${version}${dryRun ? " (dry run)" : ""}`);
console.log(`Registry: ${registry}${publicNpm ? "" : " (--access off)"}`);
console.log(
  `Provenance: ${provenance ? "yes" : "no, this is not a CI runner npm can attest from"}`,
);
console.log(`Tag:      ${tag}\n`);

execFileSync(process.execPath, [join(root, "scripts/version.mjs"), "--check"], {
  stdio: "inherit",
});

const platforms = JSON.parse(
  await readFile(join(root, "packages/runtime/platforms.json"), "utf8"),
);
const directoryFor = (target) =>
  join(platformPackages, target.package.replace("@vantail/", ""));

// Every variant of every target, not just the plain ones: a package that is
// built and not published is one nobody can install.
const allBuilds = runtimeBuilds(platforms);

const built = allBuilds.filter(
  (target) => existsSync(directoryFor(target)) && wanted(target.package),
);
const missing = only
  ? []
  : allBuilds.filter((target) => !existsSync(directoryFor(target)));

if (missing.length > 0) {
  const names = missing.map((target) => target.dir).join(", ");
  // A release must carry every platform: half a release leaves an application
  // that installs on one machine and not the next.
  if (!process.argv.includes("--partial")) {
    console.error(
      `\nNo built package for: ${names}\n` +
        `Run scripts/build-platform-packages.mjs first, or pass --partial to ` +
        `publish only what is built.`,
    );
    process.exit(1);
  }
  console.warn(`Partial: no runtime for ${names}.`);
  console.warn(`Those platforms cannot install this version.\n`);
}

if (built.length === 0 && !only) {
  console.error(
    "\nNo platform runtime packages at all - nothing to publish against.",
  );
  process.exit(1);
}

for (const directory of WORKSPACE_ORDER) {
  const name = JSON.parse(
    await readFile(join(root, directory, "package.json"), "utf8"),
  ).name;
  if (!wanted(name)) continue;
  if (!existsSync(join(root, directory, "dist"))) {
    console.error(
      `\n${directory} has not been built. Run \`pnpm build\` first.`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// The binaries
// ---------------------------------------------------------------------------

console.log("Platform runtimes:");
for (const target of built) {
  console.log(`  ${target.package}`);
  run("npm", PUBLISH, { cwd: directoryFor(target) });
}

// ---------------------------------------------------------------------------
// Manifests, patched for publication and put back afterwards
// ---------------------------------------------------------------------------

// None of this is committed. `workspace:^` is what makes the local checkout
// link package to package, and the optional dependencies name packages that
// do not exist until the loop above has run - so both would break
// `pnpm install` if they lived in the repository.

/** `workspace:^` -> `^0.1.0`, `workspace:*` -> `0.1.0`, and so on. */
function resolveWorkspaceRange(range) {
  if (!range.startsWith("workspace:")) return range;
  const rest = range.slice("workspace:".length);
  if (rest === "*" || rest === "") return version;
  if (rest === "^" || rest === "~") return `${rest}${version}`;
  return rest;
}

/**
 * npm has no idea what `workspace:` means: left alone it publishes the literal
 * string, and every install of the package then fails.
 */
function resolveWorkspaceDeps(manifest) {
  const changed = [];
  for (const group of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const deps = manifest[group];
    if (!deps) continue;

    for (const [name, range] of Object.entries(deps)) {
      const resolved = resolveWorkspaceRange(String(range));
      if (resolved === range) continue;
      deps[name] = resolved;
      changed.push(`${name}@${resolved}`);
    }
  }
  return changed;
}

const patched = [];

for (const directory of WORKSPACE_ORDER) {
  const path = join(root, directory, "package.json");
  const original = await readFile(path, "utf8");
  const manifest = JSON.parse(original);

  if (!wanted(manifest.name)) continue;

  const changed = resolveWorkspaceDeps(manifest);

  // `@vantail/runtime` is the package that resolves the binary at run time, so
  // it is the one that has to depend on the platform packages. Optional, so an
  // install on a platform this release does not cover warns rather than fails.
  if (
    manifest.name === "@vantail/runtime" &&
    (built.length > 0 || runtimeVersion)
  ) {
    const targets = runtimeVersion ? allBuilds : built;
    const at = runtimeVersion ?? version;

    // Reusing an older release's binaries can only name the packages that
    // release actually published. A variant added since then does not exist
    // at that version, and depending on it makes the whole install fail -
    // which is how the sqlcipher packages came to be referenced by a release
    // that never built them.
    if (runtimeVersion) {
      const absent = targets.filter((target) => !publishedAt(target.package, at));
      if (absent.length > 0) {
        console.error(
          `\n${absent.map((target) => target.package).join(", ")}\n` +
            `${absent.length === 1 ? "does" : "do"} not exist at ${at}, so this ` +
            `release cannot point at ${absent.length === 1 ? "it" : "them"}.\n\n` +
            `A build that is new since the last release has to be built before ` +
            `it can be depended on:\nre-run the release with the native builds ` +
            `enabled.`,
        );
        process.exit(1);
      }
    }

    manifest.optionalDependencies = Object.fromEntries(
      targets.map((target) => [target.package, at]),
    );
    changed.push(`${targets.length} platform runtime(s) at ${at}`);
  }

  patched.push({
    path,
    original,
    manifest,
    name: manifest.name,
    directory,
    changed,
  });
}

console.log("\nWorkspace packages:");
try {
  for (const entry of patched) {
    if (entry.changed.length > 0 && !dryRun) {
      await writeFile(
        entry.path,
        `${JSON.stringify(entry.manifest, null, 2)}\n`,
        "utf8",
      );
    }
  }

  for (const entry of patched) {
    const note =
      entry.changed.length > 0 ? `  (${entry.changed.join(", ")})` : "";
    console.log(`  ${entry.name}${note}`);
    run("npm", PUBLISH, { cwd: join(root, entry.directory) });
  }
} finally {
  // Put them back either way, so a failed publish does not leave the working
  // tree pointing at versions that were never sent.
  if (!dryRun) {
    for (const entry of patched)
      await writeFile(entry.path, entry.original, "utf8");
  }
}

console.log(
  `\nPublished ${version}${dryRun ? " (dry run - nothing was sent)" : ""}`,
);
