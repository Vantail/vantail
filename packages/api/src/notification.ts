import { invoke } from "./transport.js";

export interface NotificationOptions {
  /** Defaults to the application name. */
  title?: string;
  body?: string;
  /** Platform-specific icon name or path. Ignored where unsupported. */
  icon?: string;
}

/**
 * Desktop notifications.
 *
 * On macOS these are delivered through the bundle identifier, so they only
 * work from a packaged app - `vantail dev` will report `UNSUPPORTED`.
 */
export const notification = {
  show: (options: NotificationOptions | string) =>
    invoke<null>(
      "notification.show",
      typeof options === "string"
        ? { title: "", body: options }
        : { title: "", body: "", ...options },
    ),
};
