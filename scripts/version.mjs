#!/usr/bin/env node
/**
 * One version number, everywhere.
 *
 * The runtime reports its version to the SDK and the CLI writes it into every
 * generated config, so the Rust crate and the npm packages have to agree.
 * Rather than trust that, this sets them all from the root `package.json` -
 * and `--check` fails the build if they have drifted.
 *
 *   node scripts/version.mjs            # report
 *   node scripts/version.mjs --check    # fail if anything disagrees
 *   node scripts/version.mjs 0.2.0      # set everywhere
 *   node scripts/version.mjs patch      # 0.1.0 -> 0.1.1
 *   node scripts/version.mjs minor      # 0.1.0 -> 0.2.0
 *   node scripts/version.mjs dev 7      # 0.1.0 -> 0.1.1-dev.7
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every place a version is written down, and how to read or rewrite it. */
async function sites() {
  const packages = (
    await readdir(join(root, "packages"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => join("packages", entry.name, "package.json"))
    .filter((path) => existsSync(join(root, path)));

  return [
    { path: "package.json", kind: "json" },
    ...packages.map((path) => ({ path, kind: "json" })),
    { path: "Cargo.toml", kind: "cargo" },
    { path: "packages/cli/src/index.ts", kind: "cli" },
  ];
}

const PATTERNS = {
  // `version.workspace = true` in the crate, so only the workspace table.
  cargo: /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*")([^"]+)(")/,
  cli: /(export const VERSION = ")([^"]+)(")/,
};

async function read(site) {
  const text = await readFile(join(root, site.path), "utf8");
  if (site.kind === "json") return JSON.parse(text).version;
  const match = PATTERNS[site.kind].exec(text);
  return match?.[2];
}

async function write(site, version) {
  const path = join(root, site.path);
  const text = await readFile(path, "utf8");

  if (site.kind === "json") {
    // Rewritten textually so key order and formatting survive.
    const updated = text.replace(
      /("version"\s*:\s*")([^"]+)(")/,
      `$1${version}$3`,
    );
    await writeFile(path, updated, "utf8");
    return;
  }

  await writeFile(
    path,
    text.replace(PATTERNS[site.kind], `$1${version}$3`),
    "utf8",
  );
}

const argument = process.argv[2];
const all = await sites();
const found = await Promise.all(
  all.map(async (site) => [site, await read(site)]),
);

if (argument === undefined || argument === "--check") {
  const expected = found[0][1];
  const wrong = found.filter(([, version]) => version !== expected);

  for (const [site, version] of found) {
    const mark = version === expected ? "  " : "!!";
    console.log(`${mark} ${String(version).padEnd(12)} ${site.path}`);
  }

  if (argument === "--check" && wrong.length > 0) {
    console.error(
      `\n${wrong.length} file(s) disagree with package.json (${expected}).\n` +
        `Run: node scripts/version.mjs ${expected}`,
    );
    process.exitCode = 1;
  }
} else {
  const version = resolveVersion(argument, found[0][1]);
  for (const site of all) await write(site, version);
  console.log(`set ${version} in ${all.length} files`);
}

/**
 * Turn an argument into a version.
 *
 * The words are there so a bump is a word rather than a number worked out by
 * hand - getting that wrong is how two files end up disagreeing.
 */
function resolveVersion(argument, current) {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!parts) {
    console.error(`Cannot read the current version: ${current}`);
    process.exit(1);
  }
  const [major, minor, patch] = parts.slice(1).map(Number);

  switch (argument) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "dev": {
      // A prerelease of the *next* patch, so it sorts above what is released
      // and below the release that eventually supersedes it.
      const build = process.argv[3];
      if (!build || !/^[0-9A-Za-z.-]+$/.test(build)) {
        console.error("`dev` needs a build identifier: version.mjs dev 7");
        process.exit(1);
      }
      return `${major}.${minor}.${patch + 1}-dev.${build}`;
    }
    default:
      if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(argument)) {
        console.error(
          `"${argument}" is not a version. Use MAJOR.MINOR.PATCH, or major|minor|patch|dev.`,
        );
        process.exit(1);
      }
      return argument;
  }
}
