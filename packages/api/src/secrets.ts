import { invoke } from "./transport.js";

/**
 * The operating system's credential store.
 *
 * An application that holds an OAuth refresh token has to put it somewhere.
 * `localStorage` is a plaintext file in the application's data directory,
 * readable by anything running as the user. This is the Keychain on macOS,
 * the Credential Manager on Windows, and the Secret Service on Linux.
 *
 * Entries are filed under the application's `identifier`, so two Vantail
 * applications on the same machine cannot read each other's.
 *
 * ```ts
 * await secrets.set("service.refreshToken", token);
 *
 * const token = await secrets.get("service.refreshToken");
 * if (token === null) await signIn();
 * ```
 *
 * There is no `list()`: the platforms disagree about whether enumerating a
 * store is even possible, and an API that works on one of three is worse than
 * none. Keep your own index if you need one.
 */
export const secrets = {
  set: (key: string, value: string) =>
    invoke<null>("secrets.set", { key, value }),

  /** `null` when there is nothing stored - a missing secret is an answer. */
  get: (key: string) => invoke<string | null>("secrets.get", { key }),

  has: (key: string) => invoke<boolean>("secrets.has", { key }),

  /** `true` if something was removed, `false` if there was nothing there. */
  delete: (key: string) => invoke<boolean>("secrets.delete", { key }),
};
