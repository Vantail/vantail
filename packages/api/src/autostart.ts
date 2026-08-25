import { invoke } from "./transport.js";

/**
 * Starting when the user logs in.
 *
 * Each platform keeps its own register of these - a launch agent on macOS, a
 * `Run` value on Windows, a desktop entry on Linux - and all three name a
 * path, so this only works on a packaged application. Calling it from
 * `vantail dev` throws `UNSUPPORTED` rather than registering a path that will
 * not exist tomorrow.
 *
 * ```ts
 * if (!(await autostart.isEnabled())) await autostart.enable();
 * ```
 */
export const autostart = {
  /** Start this application at login. */
  enable(): Promise<void> {
    return invoke<void>("autostart.enable");
  },

  /** Stop starting it. Doing this twice is not an error. */
  disable(): Promise<void> {
    return invoke<void>("autostart.disable");
  },

  isEnabled(): Promise<boolean> {
    return invoke<boolean>("autostart.isEnabled");
  },
};
