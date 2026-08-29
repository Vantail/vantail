/**
 * How to spawn npm without a shell.
 *
 * On Windows npm is `npm.cmd`, a batch file, and Node will not run one from
 * `execFile` or `spawn` unless a shell is asked for - it refuses outright since
 * the argument-escaping fix in CVE-2024-27980. Spawning bare `npm` there fails
 * with ENOENT, which looks for all the world like npm not being installed.
 *
 * Naming the file is the fix. A shell would work too and is what most projects
 * reach for, but every argument here is interpolated - package names, registry
 * URLs, versions - and none of it should be within reach of a shell's quoting
 * rules on the way to a command that publishes.
 */
export const npmCommand = () =>
  process.platform === "win32" ? "npm.cmd" : "npm";
