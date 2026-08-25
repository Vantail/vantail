#!/usr/bin/env node
/**
 * Fail when something that ships has changed but the version has not.
 *
 * The registry refuses to publish over an existing version, so a forgotten
 * bump is not a silent overwrite - it is a release that dies half way, after
 * some packages are already out. Catching it on the way in is cheaper.
 *
 * Only what actually reaches a package counts. Roughly half the commits here
 * touch tests, CI or documentation, and none of that is worth a version.
 *
 *   node scripts/version-drift.mjs            # against the last release tag
 *   node scripts/version-drift.mjs --base v0.1.0
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** What ends up inside a published package, or inside the runtime binary. */
const SHIPPED = [
  /^packages\/[^/]+\/src\//,
  /^packages\/[^/]+\/templates\//,
  /^packages\/[^/]+\/package\.json$/,
  /^packages\/runtime\/platforms\.json$/,
  /^runtime\/src\//,
  /^Cargo\.toml$/,
  /^Cargo\.lock$/,
];

function git(...args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function flag(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const base =
  flag("base") || git("describe", "--tags", "--abbrev=0", "--match", "v*");

if (!base) {
  // Nothing has been released, so there is nothing to have drifted from.
  console.log("No release tag yet - nothing to compare against.");
  process.exit(0);
}

const version = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
).version;
const released = base.replace(/^v/, "");

const changed = git("diff", "--name-only", `${base}..HEAD`)
  .split("\n")
  .filter(Boolean)
  .filter((path) => SHIPPED.some((pattern) => pattern.test(path)));

if (changed.length === 0) {
  console.log(`Nothing that ships has changed since ${base}.`);
  process.exit(0);
}

if (version !== released) {
  console.log(
    `${changed.length} shipped file(s) changed since ${base}, and the version moved to ${version}.`,
  );
  process.exit(0);
}

console.error(
  `Still ${version}, but ${changed.length} file(s) that ship have changed since ${base}:\n` +
    changed
      .slice(0, 20)
      .map((path) => `  ${path}`)
      .join("\n") +
    (changed.length > 20 ? `\n  ... and ${changed.length - 20} more` : "") +
    `\n\nBump it:\n  node scripts/version.mjs patch   # or minor`,
);
process.exit(1);
