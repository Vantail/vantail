/**
 * Spawning npm has to work on the platform it is running on.
 *
 * On Windows npm is `npm.cmd`, a batch file, and Node will not run one from
 * `execFile` or `spawn` without a shell - it refuses outright since the
 * argument-escaping fix in CVE-2024-27980. Spawning bare `npm` there fails
 * with ENOENT, which reads as npm not being installed.
 *
 * That is not hypothetical: it made every registry check in the release script
 * fail on Windows, and because the failure was silent the script concluded the
 * registry had nothing to say and reported it as "no answer from npm".
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { npmCommand } from "../lib/npm.mjs";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..");

test("npm can be spawned on this platform, without a shell", () => {
  // The whole point: run it the way the release scripts run it. On Windows
  // this fails outright unless the command names the batch file.
  const version = execFileSync(npmCommand(), ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  assert.match(
    version.trim(),
    /^\d+\.\d+\.\d+/,
    `expected a version from \`${npmCommand()} --version\`, got ${version}`,
  );
});

test("no script spawns npm by a name Windows does not have", () => {
  // A guard against putting it back. The command has to come from
  // `npmCommand()`, because a literal "npm" is a name that does not exist on
  // one of the three platforms this project supports.
  const offenders = [];

  for (const name of readdirSync(scripts).filter((f) => f.endsWith(".mjs"))) {
    const source = readFileSync(join(scripts, name), "utf8");
    if (/(?:execFileSync|execFile|spawnSync|spawn|run)\(\s*"npm"/.test(source)) {
      offenders.push(name);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these spawn a literal "npm" instead of npmCommand(): ${offenders.join(", ")}`,
  );
});
