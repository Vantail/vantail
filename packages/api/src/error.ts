import { ErrorCode, type VantailErrorPayload } from "./protocol.js";

/**
 * Every failure from the native side arrives as one of these.
 *
 * `code` is the part worth branching on - the message is for humans and may
 * change between releases.
 *
 * ```ts
 * try {
 *   await filesystem.readText(path);
 * } catch (error) {
 *   if (VantailError.is(error, "PERMISSION_DENIED")) {
 *     // ask the user to pick the file instead
 *   }
 * }
 * ```
 */
export class VantailError extends Error {
  readonly code: string;
  readonly data: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = "VantailError";
    this.code = code;
    this.data = data;
  }

  static from(payload: VantailErrorPayload): VantailError {
    return new VantailError(payload.code, payload.message, payload.data);
  }

  /** Type guard, optionally narrowing to a specific code. */
  static is(error: unknown, code?: string): error is VantailError {
    if (!(error instanceof VantailError)) return false;
    return code === undefined || error.code === code;
  }
}

export const noRuntime = (): VantailError =>
  new VantailError(
    ErrorCode.NO_RUNTIME,
    "No Vantail runtime found. `@vantail/api` only works inside a Vantail window - " +
      "run your app with `vantail dev` instead of opening it in a browser.",
  );
