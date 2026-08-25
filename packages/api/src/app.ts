import { bridgeInfo, invoke, listen } from "./transport.js";

export interface AppInfo {
  name: string;
  version: string;
  identifier: string;
  isDev: boolean;
}

/** Identity and lifecycle of the running application. */
export type ProgressState =
  "none" | "normal" | "indeterminate" | "paused" | "error";

export interface ProgressOptions {
  /** 0 to 100. Leave it out to change only the state. */
  value?: number;
  state?: ProgressState;
}

export const app = {
  name: () => invoke<string>("app.name"),
  version: () => invoke<string>("app.version"),
  identifier: () => invoke<string>("app.identifier"),
  info: () => invoke<AppInfo>("app.info"),

  /** Whether the app is running under `vantail dev`. */
  isDev: () => invoke<boolean>("app.isDev"),

  /**
   * The same facts as {@link app.info}, without awaiting.
   *
   * The runtime injects them before any application code runs, so this is
   * safe to read during module evaluation. Returns `undefined` in a browser.
   */
  infoSync: (): AppInfo | undefined => {
    const info = bridgeInfo();
    if (!info) return undefined;
    const { name, version, identifier, isDev } = info;
    return { name, version, identifier, isDev };
  },

  /**
   * Send an application-defined event to another window, or to all of them.
   *
   * This is how two windows talk to each other: there is no shared memory
   * between webviews, so a message goes out through the runtime and comes
   * back in on the other side.
   *
   * ```ts
   * // in the main window
   * await app.emit("document-saved", { path }, { to: "preview" });
   *
   * // in the preview window
   * app.listen<{ path: string }>("document-saved", ({ path }) => reload(path));
   * ```
   */
  emit: (event: string, payload?: unknown, options: { to?: string } = {}) =>
    invoke<null>("app.emit", { event, payload: payload ?? null, ...options }),

  /**
   * Listen for events sent with {@link app.emit}. Returns an unsubscribe
   * function. The second argument tells you which window sent it.
   */
  listen: <T = unknown>(
    event: string,
    handler: (payload: T, meta: { from: string }) => void,
  ): (() => void) =>
    // User events travel under a `user:` prefix so an application can name
    // its events anything without colliding with `window.resized` and friends.
    listen<{ from: string; payload: T }>(`user:${event}`, (message) =>
      handler(message.payload, { from: message.from }),
    ),

  /**
   * Somebody started the application again while it was already running.
   *
   * Only fires when `singleInstance` is on, which is where the second launch
   * hands over its arguments and exits instead of opening a second copy. The
   * runtime has already brought the existing window to the front by the time
   * this arrives.
   */
  onSecondInstance: (
    handler: (launch: { args: string[]; cwd: string }) => void,
  ) => listen<{ args: string[]; cwd: string }>("app.secondInstance", handler),

  /** Close the application. Does not resolve - the process is going away. */
  /**
   * The badge on the application's icon - an unread count, usually.
   * `null` clears it.
   *
   * macOS shows any text. Linux shows a number, so a label that is not one is
   * refused there. Windows has no text badge and answers `UNSUPPORTED`.
   */
  setBadge: (label: string | number | null) =>
    invoke<null>("app.setBadge", {
      label: label === null ? null : String(label),
    }),

  /**
   * The progress bar drawn across the application's icon or taskbar button.
   *
   * ```ts
   * await app.setProgress({ value: 40, state: "normal" });
   * await app.setProgress({ state: "none" });   // done
   * ```
   */
  setProgress: (options: ProgressOptions) =>
    invoke<null>("app.setProgress", options),

  quit: () => invoke<null>("app.quit"),

  /** Relaunch the application with the same arguments. */
  restart: () => invoke<null>("app.restart"),
};
