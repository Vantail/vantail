import { VantailError } from "./error.js";
import { ErrorCode } from "./protocol.js";
import { invoke, listen } from "./transport.js";

/**
 * A keyed, observable store shared by every window.
 *
 * The runtime is the authority: writes go renderer -> runtime -> all
 * renderers, so there is no "which window wins?" race. Last write wins.
 *
 * This complements `app.emit` / `app.listen` rather than replacing them:
 * those stay the low-level fire-and-forget bus, while this is a keyed store
 * with read-before-write semantics and change subscriptions. Both ride the
 * same transport - changes arrive as `sharedState.changed` events.
 *
 * ```ts
 * await sharedState.set("demo.counter", 1);
 * const value = await sharedState.get<number>("demo.counter", 0);
 * const stop = sharedState.subscribe<number>("demo.counter", (v) => show(v));
 * ```
 *
 * Values must be JSON-serializable. Framework adapters (a React
 * `useSyncExternalStore` hook, a Vue `ref` wrapper) are consumer-side and out
 * of scope for core - `subscribe` returns a plain callback + unsubscribe
 * function so that wiring is trivial without a shim.
 */
export const sharedState = {
  /**
   * The current value, or `default` when the key is unset.
   *
   * A provided `default` is never written implicitly.
   */
  get<T>(key: string, def?: T): Promise<T> {
    let params: unknown;
    try {
      params = def === undefined ? { key } : { key, default: serializable(key, def) };
    } catch (error) {
      return Promise.reject(error);
    }
    return invoke<T>("sharedState.get", params);
  },

  /** Write the value and broadcast the change to every window. */
  set<T>(key: string, value: T): Promise<void> {
    let serial: T;
    try {
      serial = serializable(key, value);
    } catch (error) {
      return Promise.reject(error);
    }
    return invoke<void>("sharedState.set", {
      key,
      value: serial,
    });
  },

  /**
   * Call `callback` with the current value immediately, then with every
   * subsequent change. Returns an idempotent unsubscribe function.
   */
  subscribe<T>(key: string, callback: (value: T) => void): () => void {
    let stopped = false;
    // Late subscribers get the current value on subscribe: the runtime
    // answers `sharedState.subscribe` with it, and changes follow as events.
    void invoke<T>("sharedState.subscribe", { key }).then(
      (current) => {
        if (!stopped) callback(current);
      },
      () => {
        // A rejection (e.g. PERMISSION_DENIED) leaves nothing to listen for.
        // The `get`/`set` path surfaces the same error; swallowing here keeps
        // `subscribe` from becoming an unhandled rejection for a caller that
        // only wanted updates.
      },
    );

    const stop = listen<{ key: string; value: T }>(
      "sharedState.changed",
      (event) => {
        if (!stopped && event.key === key) callback(event.value);
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
 * Reject what cannot cross the IPC boundary with the stable code, before
 * anything is sent. `undefined`, functions and symbols vanish in JSON;
 * `bigint` throws; circular structures throw.
 */
function serializable<T>(key: string, value: T): T {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    throw new VantailError(
      ErrorCode.SHARED_STATE_NOT_SERIALIZABLE,
      `Shared state value for \`${key}\` is not JSON-serializable`,
    );
  }
  try {
    JSON.stringify(value);
  } catch {
    throw new VantailError(
      ErrorCode.SHARED_STATE_NOT_SERIALIZABLE,
      `Shared state value for \`${key}\` is not JSON-serializable`,
    );
  }
  return value;
}
