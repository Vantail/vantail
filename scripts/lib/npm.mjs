/**
 * How to run npm from a Node script, on every platform, without a shell.
 *
 * The obvious `execFileSync("npm", ...)` does not work on Windows. There npm
 * is `npm.cmd`, a batch file, and Node will not spawn one: bare `npm` is
 * ENOENT because no such file exists, and naming `npm.cmd` is EINVAL because
 * Node refuses batch files outright unless `shell: true` is asked for - the
 * argument-escaping fix from CVE-2024-27980.
 *
 * `shell: true` would work and is what most projects reach for. It is not used
 * here: every argument is interpolated - package names, registry URLs, paths,
 * versions - and none of it should pass through cmd.exe's quoting rules on the
 * way to a command that publishes. Node's own documentation says as much.
 *
 * So npm's entry script is run with the Node already running this, which is
 * what the `npm` shim does anyway. No shell, no batch file, nothing for
 * quoting to get wrong.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * npm's entry script, if it can be found next to the running Node.
 *
 * Two layouts cover every install this project has met: Windows keeps npm
 * beside `node.exe`, and everywhere else `node` is in `<prefix>/bin` with npm
 * under `<prefix>/lib`. A global `npm install -g npm@latest` - which the
 * release workflow does - replaces the package in place, so this finds the
 * upgraded npm rather than the one Node shipped with.
 */
function npmCliPath() {
  const beside = dirname(process.execPath);

  const appData = process.env.APPDATA;

  return [
    // Windows, and the tool cache a CI runner unpacks Node into: npm sits
    // beside node.exe.
    join(beside, "node_modules", "npm", "bin", "npm-cli.js"),
    // Everywhere else: node is in `<prefix>/bin`, npm under `<prefix>/lib`.
    join(beside, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    // A Windows `npm install -g` with the default user prefix.
    ...(appData
      ? [join(appData, "npm", "node_modules", "npm", "bin", "npm-cli.js")]
      : []),
  ].find((candidate) => existsSync(candidate));
}

/**
 * What to spawn to run npm with `args`, as `[command, argv]`.
 *
 * Pass it straight to `execFileSync`. No `shell` option is needed or wanted.
 */
export function npmSpawn(args) {
  const cli = npmCliPath();
  if (cli) return [process.execPath, [cli, ...args]];

  // Nothing found beside Node: fall back to whatever is on PATH. Right
  // everywhere but Windows, and on Windows there is nothing better to try -
  // it will fail, but it will fail saying so rather than silently.
  return ["npm", args];
}

/** How to write the command in a log line, where the real argv is noise. */
export const NPM = "npm";
