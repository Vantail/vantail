import { invoke } from "./transport.js";

/** A protected resource with a requestable system prompt. macOS only. */
export type PrivacyKind = "microphone" | "camera";

/**
 * What the OS currently thinks. `not-determined` means no prompt has ever
 * been answered; `restricted` means neither the user nor the app can change
 * it (MDM, Screen Time). Off macOS this is always `unsupported`.
 */
export type PrivacyStatus =
  | "not-determined"
  | "authorized"
  | "denied"
  | "restricted"
  | "unsupported";

/**
 * The operating system's privacy decision - not Vantail's permission layer.
 *
 * Vantail permissions gate what the application may ask the runtime to do;
 * this reports what the *process* may do with the OS. No config flag grants
 * it, and none is needed to ask: the prompt is the user's to answer.
 *
 * ```ts
 * const { status } = await privacy.status("microphone");
 * if (status === "not-determined") {
 *   const answer = await privacy.request("microphone");
 *   // ... "authorized" or "denied"
 * }
 * ```
 *
 * First call shows the normal system prompt (attributed to the running app,
 * which needs the matching `macos.*UsageDescription` in its `Info.plist` -
 * see `docs/macos-privacy.md`). Later calls return the stored decision.
 * Only the user, in System Settings, can reverse a denial.
 */
export const privacy = {
  /** The current decision, without prompting. */
  status(kind: PrivacyKind): Promise<{ status: PrivacyStatus }> {
    return invoke<{ status: PrivacyStatus }>("privacy.status", { kind });
  },

  /**
   * Ask for access, showing the system prompt the first time. Afterwards it
   * answers from the stored decision, like `status`.
   */
  request(kind: PrivacyKind): Promise<{ status: PrivacyStatus }> {
    return invoke<{ status: PrivacyStatus }>("privacy.request", { kind });
  },

  /** Open the Privacy & Security settings pane, for reversing a denial. */
  openSettings(): Promise<void> {
    return invoke<void>("privacy.openSettings");
  },
};
