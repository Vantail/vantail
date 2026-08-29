#!/usr/bin/env node
/**
 * The runtime version a release can reuse, if there is one.
 *
 * A release that changes no Rust points at binaries that are already
 * published instead of rebuilding five of them. This answers which version
 * those are - the newest one that *every* platform package actually has,
 * since the release declares them all at a single version and one missing
 * package fails the whole install.
 *
 *   node scripts/last-runtime-version.mjs            # prints it, or fails
 *   node scripts/last-runtime-version.mjs --check    # exit 0 if reuse works
 *
 * `--check` is what the release plan uses to decide whether the native builds
 * can be skipped. When they cannot - a new variant nobody has published, or a
 * registry that answers something unusable - the answer is to build them, not
 * to fail the release.
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runtimeBuilds } from "./lib/runtime-builds.mjs";
import {
  neverPublished,
  newestCommonVersion,
} from "./lib/runtime-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

function flag(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

/** Every version the registry has of one package. `[]` if it has none. */
function versionsOf(name) {
  const args = ["view", name, "versions", "--json"];
  const registry = flag("registry");
  if (registry) args.push("--registry", registry);
  const userconfig = flag("userconfig");
  if (userconfig) args.push("--userconfig", userconfig);

  let raw;
  try {
    raw = execFileSync("npm", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // An unpublished package is an answer, not a failure: it is precisely the
    // case that means "this release has to build the runtimes".
    return [];
  }

  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

const platforms = JSON.parse(
  await readFile(join(root, "packages/runtime/platforms.json"), "utf8"),
);

const published = Object.fromEntries(
  runtimeBuilds(platforms).map((build) => [build.package, versionsOf(build.package)]),
);

const missing = neverPublished(published);
const version = newestCommonVersion(published);

if (!version) {
  const reason =
    missing.length > 0
      ? `never published: ${missing.join(", ")}`
      : "no single version is common to all of them";

  // Not an error on `--check`: the caller asked whether reuse is possible, and
  // "no" is a usable answer that turns into building the runtimes instead.
  const say = check ? console.log : console.error;
  say(
    `No runtime version can be reused (${reason}).\n` +
      `This release has to build the native runtimes.`,
  );
  process.exit(1);
}

if (check) {
  console.log(`Can reuse runtime ${version}.`);
  process.exit(0);
}

console.log(version);
