/**
 * Running npm from a Node script has to work on all three platforms.
 *
 * Windows is the one that breaks. There npm is `npm.cmd`, a batch file:
 * spawning bare `npm` is ENOENT because no such file exists, and spawning
 * `npm.cmd` is EINVAL because Node refuses batch files outright without
 * `shell: true` - the argument-escaping fix from CVE-2024-27980.
 *
 * Both were shipped, in that order. The first made every registry check in the
 * release script fail silently, so the script decided the registry had nothing
 * to say. The second was the attempt to fix the first.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { npmSpawn } from "../lib/npm.mjs";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..");

test("npm actually runs, spawned the way the release scripts spawn it", () => {
  const version = execFileSync(...npmSpawn(["--version"]), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  assert.match(
    version.trim(),
    /^\d+\.\d+\.\d+/,
    `expected a version from npm, got ${version}`,
  );
});

test("never asks Node to spawn a batch file", () => {
  // The property that makes this work on Windows, checked on every platform
  // so it cannot be broken from a Mac. Node rejects `.cmd` and `.bat` with
  // EINVAL unless a shell is asked for, and a shell is what this avoids.
  const [command] = npmSpawn(["--version"]);

  assert.doesNotMatch(
    command.toLowerCase(),
    /\.(cmd|bat)$/,
    `Node will not spawn ${command} without a shell`,
  );
});

test("runs npm's own entry script, not the launcher on PATH", () => {
  // The Windows-safe form, and the only one that avoids a shell: this Node,
  // running the script the `npm` shim would have run. If npm cannot be found
  // beside Node the code falls back to the PATH launcher, which works
  // everywhere except the one platform that needed the help - so failing here
  // is the signal that the fallback is in play.
  const [command, argv] = npmSpawn(["--version"]);

  assert.equal(command, process.execPath, "npm should run through this Node");
  assert.match(argv[0], /npm-cli\.js$/, `expected npm's entry script, got ${argv[0]}`);
});

test("no script spawns npm by name", () => {
  // A guard against putting either mistake back: the command has to come from
  // `npmSpawn`, because neither "npm" nor "npm.cmd" is a thing Node can run on
  // every platform.
  const offenders = [];

  for (const name of readdirSync(scripts).filter((f) => f.endsWith(".mjs"))) {
    const source = readFileSync(join(scripts, name), "utf8");
    if (/(?:execFileSync|execFile|spawnSync|spawn|run)\(\s*"npm(\.cmd)?"/.test(source)) {
      offenders.push(name);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these name npm directly instead of using npmSpawn(): ${offenders.join(", ")}`,
  );
});
