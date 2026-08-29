#!/usr/bin/env node
/**
 * The runtime version the last release published.
 *
 * A release that changes no Rust reuses those binaries instead of rebuilding
 * five of them, so it needs to know which version to point at. `@vantail/runtime`
 * is the package that names them, and its `optionalDependencies` are exactly
 * that answer - more reliable than guessing a platform package, since a
 * release need not have covered every platform.
 *
 *   node scripts/last-runtime-version.mjs
 *   node scripts/last-runtime-version.mjs --userconfig .npmrc
 */

import { execFileSync } from "node:child_process";

import { isVersion, versionsFrom } from "./lib/runtime-version.mjs";

function flag(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const args = [
  "view",
  "@vantail/runtime@latest",
  "optionalDependencies",
  "--json",
];
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
  console.error("Could not read @vantail/runtime from the registry.");
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(raw || "{}") ?? {};
} catch {
  console.error(
    `Could not parse what the registry returned: ${raw.slice(0, 200)}`,
  );
  process.exit(1);
}

const found = versionsFrom(parsed);
const bad = found.filter((value) => !isVersion(value));

if (bad.length > 0) {
  console.error(
    `@vantail/runtime names its platform packages at something that is not a\n` +
      `version: ${bad.map((value) => JSON.stringify(value)).join(", ")}\n\n` +
      `Publishing that would make every binary unresolvable. Release with the\n` +
      `native builds enabled so the versions are written fresh.`,
  );
  process.exit(1);
}

const unique = found;

if (unique.length === 0) {
  console.error(
    "The published @vantail/runtime names no platform packages, so there are\n" +
      "no binaries to reuse. Release with the native builds enabled.",
  );
  process.exit(1);
}

if (unique.length > 1) {
  console.error(`Its platform packages disagree: ${unique.join(", ")}`);
  process.exit(1);
}

console.log(unique[0]);
