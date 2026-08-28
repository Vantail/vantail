/**
 * The wire protocol, as the browser side sees it.
 *
 * Intentionally duplicated from `@vantail/shared` rather than imported:
 * `@vantail/api` ships into application bundles, and a UI package with zero
 * dependencies is worth more than one shared file. `packages/shared` holds
 * the same shapes for the tooling side, and `runtime/src/ipc` for the native
 * side; all three are checked against each other by the protocol tests.
 */

export interface VantailRequest {
  id: string;
  method: string;
  params?: unknown;
}

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

/** Stable error codes. `NO_RUNTIME` is the only one the SDK raises itself. */
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

/** The object the runtime injects before any page script runs. */

/**
 * The room a hidden title bar left behind, in logical pixels.
 *
 * Also set on `:root` as `--vantail-titlebar-height`,
 * `--vantail-titlebar-inset-left` and `--vantail-titlebar-inset-right`, before
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
}

export interface VantailBridge {
  version: string;
  /** The label of the window this page is running in. */
  label: string;
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
  subscribe(listener: (message: VantailIncoming) => void): () => void;
}

declare global {
  interface Window {
    __VANTAIL__?: VantailBridge;
  }
}
