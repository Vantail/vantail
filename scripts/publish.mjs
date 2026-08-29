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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runtimeBuilds } from "./lib/runtime-builds.mjs";
import { npmCommand } from "./lib/npm.mjs";
import { isVersion } from "./lib/runtime-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const platformPackages = resolve(flag("packages", "dist-packages"));

/** What to spawn for npm on this platform. */
const NPM = npmCommand();

/**
 * How long to wait on the registry before giving up on a question.
 *
 * npm's own default is to retry with backoff for minutes, which is right for
 * a publish and wrong for a question. Everything below is a question asked
 * before anything is sent, and a registry that is not answering should stop
 * the run rather than hang it - point these at a host that does not resolve
 * and without a bound they never come back at all.
 */
const PROBE = {
  encoding: "utf8",
  // stderr captured rather than dropped: it is what tells a "no" from a
  // question that never got asked.
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 20_000,
};

/**
 * Ask npm once rather than waiting out its retry schedule.
 *
 * Only the retry count. The retry *timeouts* are a trap: npm refuses a
 * `fetch-retry-maxtimeout` below its own `fetch-retry-mintimeout` of 10s and
 * fails the command outright with "minTimeout is greater than maxTimeout" - on
 * every call, for every package. With no retries the timeouts govern nothing
 * anyway, so there is nothing to say about them.
 */
const NO_RETRIES = ["--fetch-retries", "0"];

/** The registry and credential flags every probe passes through. */
function probeFlags() {
  const args = [...NO_RETRIES];
  const registry = flag("registry");
  if (registry) args.push("--registry", registry);
  const userconfig = flag("userconfig");
  if (userconfig) args.push("--userconfig", userconfig);
  return args;
}

/**
 * What the registry says about a spec: `true` it has it, `false` it does not,
 * `null` it could not be asked.
 *
 * The third answer is the point. Reading "could not ask" as "does not exist"
 * is how a network blip or a bad flag becomes a release that stops with a
 * confident and wrong explanation - which is what a `fetch-retry-maxtimeout`
 * below npm's own minimum did: npm refused the config, every probe failed, and
 * six packages that had been on the registry for months were reported as never
 * published.
 *
 * A 404 is a real answer - the registry was reached and has nothing. Anything
 * else is silence.
 */
function known(spec) {
  try {
    const out = execFileSync(NPM, ["view", spec, "version", ...probeFlags()], PROBE);
    return out.trim().length > 0;
  } catch (error) {
    const said = `${error.stderr ?? ""}`;
    if (/E404|404 Not Found/.test(said)) return false;
    unanswered.set(spec, whyItFailed(error));
    return null;
  }
}

/**
 * The line of npm's output worth repeating, or a description of how it died.
 *
 * Not simply the first line. npm writes warnings to the same stream, and under
 * pnpm the first of them is always `npm warn Unknown env config
 * "verify-deps-before-run"` - so a release that stopped because it could not
 * reach the registry explained itself by complaining about a config key, on
 * Linux only, which is a fine way to spend an afternoon. Windows managed worse
 * and said nothing at all, because there was no stderr to quote.
 */
function whyItFailed(error) {
  const lines = `${error.stderr ?? ""}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("npm warn"));

  const complaint = lines.find((line) => line.startsWith("npm error")) ?? lines[0];
  if (complaint) return complaint;

  // Nothing on stderr: say how it ended instead of saying nothing.
  if (error.signal === "SIGTERM") return "npm did not answer in time";
  if (error.signal) return `npm was killed by ${error.signal}`;
  if (error.code === "ENOENT") return "npm is not on PATH";
  return `npm exited with status ${error.status ?? "unknown"}`;
}

/** Specs the registry could not be asked about, and why. */
const unanswered = new Map();

/** Say what went unasked, so a check that did not happen does not read as one that passed. */
function reportUnanswered() {
  if (unanswered.size === 0) return;
  console.warn(
    `\nCould not ask ${registry} about:\n` +
      [...unanswered]
        .map(([spec, why]) => `  ${spec} - ${why}`)
        .join("\n") +
      `\n\nTaking those as unknown rather than as missing. A name that really\n` +
      `is new will still fail at its own publish, with npm's own error.`,
  );
  unanswered.clear();
}

/**
 * Whether the registry already has this package at this version.
 *
 * Asked twice over: on the path that reuses an older release's binaries, where
 * naming a package that was never published makes the whole install fail; and
 * before each publish, so a release that stopped half way can be run again and
 * pick up where it left off.
 */
const publishedAt = (name, version) => known(`${name}@${version}`);

/** Whether this package exists on the registry at all. */
const everPublished = (name) => known(name);

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
    const value = execFileSync(NPM, ["config", "get", key, ...where], {
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

/**
 * Whether this run is authenticated as an account, rather than relying on
 * trusted publishing.
 *
 * It decides whether a package that does not exist yet can be created: npm's
 * OIDC publishing works against a package whose trusted publisher is already
 * configured, and there is nothing to configure until the package exists. The
 * first publish of a name has to come from an account.
 *
 * Asked of npm rather than worked out from files. Credentials arrive through
 * `npm login` writing `~/.npmrc`, through the project `.npmrc`, or through the
 * environment, and checking only some of those would refuse to let somebody
 * publish while they were perfectly well logged in.
 */
function isAuthenticated() {
  try {
    const who = execFileSync(
      NPM,
      ["whoami", "--registry", registry, ...NO_RETRIES, ...AUTH],
      PROBE,
    );
    return who.trim().length > 0;
  } catch {
    return false;
  }
}

/** The workspace packages this run would publish, by name. */
function patchedNames() {
  return WORKSPACE_ORDER.map(
    (directory) =>
      JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")).name,
  ).filter((name) => wanted(name));
}

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
// Can everything here actually be published?
// ---------------------------------------------------------------------------

// Asked before anything is sent. A name that cannot be created fails at the
// moment it is reached, and by then the packages before it are already public
// - which is how a release ends up half out, with a resolver pointing at
// binaries that do not exist.
// Checked on a dry run too: a rehearsal that cannot tell you the release
// would stop half way is not much of a rehearsal.
if (!isAuthenticated()) {
  const brandNew = [
    ...built.map((target) => target.package),
    ...patchedNames(),
  ].filter((name) => everPublished(name) === false);
  reportUnanswered();

  if (brandNew.length > 0) {
    console.error(
      `\nThese packages do not exist on ${registry} yet:\n` +
        brandNew.map((name) => `  ${name}`).join("\n") +
        `\n\nThis run is not logged in, so it is publishing through trusted\n` +
        `publishing - and that works against a package whose trusted publisher\n` +
        `is already configured. There is nothing to configure until the package\n` +
        `exists, so the first publish of a name has to come from an account.\n\n` +
        `From a machine of your own:\n` +
        `  npm login\n` +
        `  node scripts/publish.mjs --i-mean-it-publish-publicly --packages dist-packages\n\n` +
        `Nothing has been published by this run.`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// The binaries
// ---------------------------------------------------------------------------

console.log("Platform runtimes:");
for (const target of built) {
  // A release that stopped half way can be run again: what is already out at
  // this version is left alone rather than failing on a version conflict.
  // `=== true` deliberately: an unanswered check means publish and let npm
  // be the one to say it is already there, rather than skipping on a guess.
  if (!dryRun && publishedAt(target.package, version) === true) {
    console.log(`  ${target.package}  (already at ${version})`);
    continue;
  }
  console.log(`  ${target.package}`);
  run(NPM, PUBLISH, { cwd: directoryFor(target) });
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
      const absent = targets.filter(
        (target) => publishedAt(target.package, at) === false,
      );
      reportUnanswered();
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
    if (!dryRun && publishedAt(entry.name, version) === true) {
      console.log(`  ${entry.name}  (already at ${version})`);
      continue;
    }
    console.log(`  ${entry.name}${note}`);
    run(NPM, PUBLISH, { cwd: join(root, entry.directory) });
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
