#!/usr/bin/env node
/**
 * Has the native runtime actually changed since a given ref?
 *
 * The release workflow asks this twice: to decide whether five native builds
 * are worth running, and to decide whether a dev build may pair new TypeScript
 * with the last release's binaries.
 *
 * The naive answer - "did Cargo.toml or Cargo.lock move" - is wrong, because
 * `version.mjs` bumps the crate version on every release. That made every
 * release rebuild all five runtimes, and made every dev build after a release
 * skip itself with "the runtime has changed".
 *
 *   node scripts/runtime-changed.mjs --base v0.1.0    # prints true or false
 *   node scripts/runtime-changed.mjs --base v0.1.0 --repo /some/checkout
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function flag(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

/** This checkout by default; `--repo` is what lets the tests drive it. */
const root =
  flag("repo") ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const base = flag("base");
if (!base) {
  console.error("Usage: runtime-changed.mjs --base <ref>");
  process.exit(2);
}

/** The crate's own sources and its dependency list. */
const SOURCES = ["runtime/src", "runtime/Cargo.toml"];

/**
 * The workspace files, where a version bump is noise but a dependency change
 * is not. `cargo update` touches only Cargo.lock and does change the binary,
 * so the file cannot simply be ignored.
 */
const WORKSPACE = ["Cargo.toml", "Cargo.lock"];

try {
  if (git("diff", "--name-only", `${base}..HEAD`, "--", ...SOURCES).trim()) {
    console.log("true");
    process.exit(0);
  }

  const cargo = git("diff", `${base}..HEAD`, "--", ...WORKSPACE)
    .split("\n")
    // Hunk headers and file markers are not content.
    .filter((line) => /^[+-]/.test(line) && !/^([+-]){3}/.test(line))
    .filter((line) => !/^[+-]version = "/.test(line));

  console.log(cargo.length > 0 ? "true" : "false");
} catch (error) {
  // An unknown ref, a shallow clone with no history: rebuilding is the safe
  // answer, since shipping the wrong binaries is worse than a slow release.
  console.error(`Could not compare against ${base}: ${error.message}`);
  console.log("true");
}
