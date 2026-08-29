/**
 * The wire protocol between a Vantail application and its native runtime.
 *
 * One request, one response, matched by `id`. Nothing else crosses the
 * boundary: no handles, no callbacks, no shared memory. Keeping it this
 * boring is what lets the SDK be a thin wrapper and the runtime a plain
 * `match` statement.
 */

/** A call from JavaScript into the runtime. */
export interface VantailRequest {
  id: string;
  /** Namespaced method name, e.g. `filesystem.readText`. */
  method: string;
  params?: unknown;
}

/** The error half of a response. `code` is stable and safe to branch on. */
export interface VantailErrorPayload {
  code: string;
  message: string;
  data?: unknown;
}

export interface VantailResponse {
  id: string;
  result?: unknown;
  error?: VantailErrorPayload;
}

/** An unsolicited push from the runtime, e.g. the window was resized. */
export interface VantailEventMessage {
  event: string;
  payload: unknown;
}

export type VantailIncoming = VantailResponse | VantailEventMessage;

export function isEventMessage(
  message: VantailIncoming,
): message is VantailEventMessage {
  return typeof (message as VantailEventMessage).event === "string";
}

/**
 * Error codes the runtime can return.
 *
 * `NO_RUNTIME` is the one code produced by the SDK itself: it means the page
 * is running in a plain browser, with no runtime on the other end.
 */
export const ErrorCode = {
  NO_RUNTIME: "NO_RUNTIME",
  UNKNOWN_METHOD: "UNKNOWN_METHOD",
  INVALID_PARAMS: "INVALID_PARAMS",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  NOT_FOUND: "NOT_FOUND",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  IO_ERROR: "IO_ERROR",
  INVALID_UTF8: "INVALID_UTF8",
  UNSUPPORTED: "UNSUPPORTED",
  INTERNAL: "INTERNAL",
  /** The caller abandoned the request before it answered. */
  CANCELLED: "CANCELLED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * The object the runtime injects before any page script runs.
 *
 * It is a pipe and nothing more - promises, typed methods and event
 * subscriptions are all built on top of it in `@vantail/api`, so the
 * protocol can grow without shipping a new runtime.
 */

/**
 * The room a hidden title bar left behind, in logical pixels.
 *
 * Also set on `:root` as `--vantail-titlebar-height`,
 * `--vantail-titlebar-inset-left`, `--vantail-titlebar-inset-right`,
 * `--vantail-titlebar-button-top` and `--vantail-titlebar-button-height`, before
 * the page lays out - which is usually the form you want, since CSS can then
 * size the toolbar without JavaScript running at all.
 */
export interface TitleBarMetrics {
  /** How tall the platform's own title bar is. `0` when there is one. */
  height: number;
  /** Room the system's window buttons need on the leading edge. */
  insetLeft: number;
  /** The same on the trailing edge. `0` on macOS. */
  insetRight: number;
  /**
   * The gap above the system's window buttons, and how tall they are.
   *
   * What a bar taller than the buttons needs in order to line anything up with
   * them: `insetLeft` says how much room they take across, and this says where
   * they sit down the bar. Not something to work out from `height` - the
   * platform does not always centre them, and only it knows where it put them.
   *
   * Both `0` where there are no system buttons: hidden, or a platform that
   * loses them along with the title bar.
   */
  buttonTop: number;
  /** How tall those buttons are. */
  buttonHeight: number;
}

export interface VantailBridge {
  /** Version of the native runtime that injected this bridge. */
  version: string;
  /** Static application facts, available without a round trip. */
  app: {
    name: string;
    version: string;
    identifier: string;
    isDev: boolean;
    platform: string;
    arch: string;
  };
  /** The room a hidden title bar left behind. Zeroes when there is a bar. */
  titleBar: TitleBarMetrics;
  postMessage(message: VantailRequest): void;
  /** Returns an unsubscribe function. */
  subscribe(listener: (message: VantailIncoming) => void): () => void;
}

declare global {
  interface Window {
    __VANTAIL__?: VantailBridge;
  }
}
