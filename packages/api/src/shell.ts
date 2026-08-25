import { invoke } from "./transport.js";

/**
 * Handing something to the system's default application.
 *
 * Small API, large blast radius: on every platform "open this path" can mean
 * "run this program". It is denied unless `permissions.shell.open` says
 * otherwise, and the pattern is matched against the exact string you pass.
 */
export const shell = {
  /** A URL, or a path to a file or directory. */
  open: (target: string, options: { with?: string } = {}) =>
    invoke<null>("shell.open", { target, ...options }),
};
