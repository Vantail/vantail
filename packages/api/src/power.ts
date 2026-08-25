import { invoke, listen } from "./transport.js";

/**
 * The machine going to sleep, and coming back.
 *
 * A page cannot notice this on its own. There is no browser API for it, and
 * nothing executes while the machine is asleep, so a timer cannot tell either
 * - all it can observe afterwards is that time jumped.
 *
 * What it is usually for is a connection that will not survive a lid closing:
 * drop it on the way down, open it again on the way back, rather than waiting
 * for a socket to notice it is dead.
 *
 * ```ts
 * power.onSuspend(() => bot.disconnect());
 * power.onResume(() => bot.connect());
 * ```
 *
 * **macOS only for now.** Elsewhere these simply never fire, rather than
 * firing at the wrong moment. Ask {@link power.supported} and keep your own
 * reconnect timer where the answer is `false`.
 */
export const power = {
  /** The machine is about to sleep. There is very little time here. */
  onSuspend: (handler: () => void) =>
    listen<Record<string, never>>("power.suspending", handler),

  /** It woke up. */
  onResume: (handler: () => void) =>
    listen<Record<string, never>>("power.resumed", handler),

  /** Whether this platform reports either of the above. */
  supported: () => invoke<boolean>("os.powerEvents"),
};
