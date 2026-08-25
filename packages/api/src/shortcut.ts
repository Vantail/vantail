import { invoke, listen } from "./transport.js";

export interface Shortcut {
  /** What {@link shortcut.onPressed} reports. The accelerator, unless given. */
  id: string;
  /** The combination itself, e.g. `CmdOrCtrl+Shift+K`. */
  accelerator: string;
}

export interface RegisterOptions {
  /**
   * A name for this shortcut, if the accelerator is not one you want to
   * switch on. Handy when the combination is configurable.
   */
  id?: string;
}

/**
 * Key combinations that fire while your application is in the background.
 *
 * A page only sees keys while it has focus, which is exactly what a global
 * shortcut is not for - so this is native.
 *
 * Registration is system-wide, so it can fail because another application
 * already owns the combination. That throws `ALREADY_EXISTS`, and it is worth
 * handling: it is an ordinary thing to happen, not a bug.
 *
 * ```ts
 * await shortcut.register("CmdOrCtrl+Shift+K", { id: "toggle" });
 * shortcut.onPressed(({ id }) => {
 *   if (id === "toggle") void appWindow.show();
 * });
 * ```
 */
export const shortcut = {
  /** Claim a combination system-wide. */
  register(
    accelerator: string,
    options: RegisterOptions = {},
  ): Promise<Shortcut> {
    return invoke<Shortcut>("shortcut.register", { accelerator, ...options });
  },

  /** Give one back. Throws `NOT_FOUND` if it was never registered. */
  unregister(accelerator: string): Promise<void> {
    return invoke<void>("shortcut.unregister", { accelerator });
  },

  /** Give all of them back. */
  unregisterAll(): Promise<void> {
    return invoke<void>("shortcut.unregisterAll");
  },

  /** Whether *this application* holds it. Another one might. */
  isRegistered(accelerator: string): Promise<boolean> {
    return invoke<boolean>("shortcut.isRegistered", { accelerator });
  },

  /** Everything this application currently holds. */
  list(): Promise<Shortcut[]> {
    return invoke<Shortcut[]>("shortcut.list");
  },

  /** Fires on press, wherever the user happens to be. */
  onPressed(handler: (shortcut: Shortcut) => void): () => void {
    return listen<Shortcut>("shortcut.pressed", handler);
  },
};
