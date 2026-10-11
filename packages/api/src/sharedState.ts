import { VantailError } from "./error.js";
import { ErrorCode } from "./protocol.js";
import { invoke, listen } from "./transport.js";

interface ChangedPayload {
  key: string;
  value: unknown;
}

/**
 * State shared between every window of the application.
 *
 * The runtime owns the values; windows hold synchronised copies. A write
 * goes out through the runtime and back into every window - including the
 * one that made it - so two windows never disagree for longer than a round
 * trip. The last write wins; there is no conflict resolution.
 *
 * This complements `app.emit` / `app.listen` rather than replacing it: those
 * stay the fire-and-forget message bus, while this is a keyed store with
 * read-before-write semantics and change subscriptions.
 *
 * ```ts
 * // in either window
 * await sharedState.set("demo.theme", "dark");
 *
 * // in both windows - the current value arrives at once, then changes
 * const stop = sharedState.subscribe<string>("demo.theme", (theme) => {
 *   document.documentElement.dataset.theme = theme;
 * });
 * ```
 *
 * Needs `permissions.sharedState` in `vantail.config.ts`. Values must be
 * JSON-serialisable. Framework adapters (`useSyncExternalStore` and friends)
 * are consumer-side: `subscribe` delivers the current value immediately, so
 * wiring one up needs no shim.
 */
export const sharedState = {
  /**
   * The current value, or `defaultValue` when the key is unset. Passing a
   * default does not write it - the key stays unset until someone sets it.
   */
  get: <T = unknown>(key: string, defaultValue?: T): Promise<T> =>
    invoke<T>("sharedState.get", defaultValue === undefined ? { key } : { key, default: defaultValue }),

  /**
   * Write a value and broadcast the change to every window, including this
   * one. Rejects with `SHARED_STATE_KEY_DENIED` when no `write` pattern
   * covers the key, and with `SHARED_STATE_NOT_SERIALIZABLE` when the value
   * cannot cross as JSON.
   */
  set: async <T = unknown>(key: string, value: T): Promise<void> => {
    assertSerializable(value);
    return invoke<void>("sharedState.set", { key, value });
  },

  /**
   * Call `callback` with the current value at once, then with every change.
   * Returns an idempotent unsubscribe function.
   */
  subscribe: <T = unknown>(key: string, callback: (value: T) => void): (() => void) => {
    // Listening first, so a change that lands between the subscribe and the
    // read still reaches the callback through the event below.
    const stop = listen<ChangedPayload>("sharedState.changed", (event) => {
      if (event.key === key) callback(event.value as T);
    });

    let stopped = false;
    // The runtime answers with the current value, which is what makes a late
    // subscriber converge without waiting for the next write.
    invoke<T>("sharedState.subscribe", { key }).then(
      (value) => {
        if (!stopped) callback(value);
      },
      // A refusal (reads not granted, bad key) has nowhere to go on a sync
      // subscribe - report it rather than leaving an unhandled rejection.
      (error: unknown) => {
        if (!stopped) console.error(`[vantail] sharedState.subscribe("${key}") failed`, error);
      },
    );

    return () => {
      if (stopped) return;
      stopped = true;
      stop();
    };
  },
};

/**
 * Whether a value can cross to the runtime as JSON.
 *
 * `undefined`, functions and symbols vanish in `JSON.stringify` rather than
 * failing - which would store `null` for something the caller never meant -
 * and `BigInt` and circular structures throw. Refuse all of them up front
 * with the same code the runtime answers with.
 */
function assertSerializable(value: unknown): void {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    throw new VantailError(
      ErrorCode.SHARED_STATE_NOT_SERIALIZABLE,
      "This value cannot be shared between windows: it is not JSON-serialisable",
    );
  }
  try {
    // `JSON.stringify` returns `undefined` (rather than throwing) for the
    // shapes above; anything else unrepresentable throws here.
    if (JSON.stringify(value) === undefined) {
      throw new Error("not JSON-serialisable");
    }
  } catch {
    throw new VantailError(
      ErrorCode.SHARED_STATE_NOT_SERIALIZABLE,
      "This value cannot be shared between windows: it is not JSON-serialisable",
    );
  }
}
