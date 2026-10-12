import { os, privacy } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/**
 * macOS privacy (TCC), demonstrated with the microphone.
 *
 * The microphone is the kind to try first: its prompt is straightforward to
 * trigger, and denying it is harmless. The camera works the same way, through
 * `privacy.status("camera")` and `privacy.request("camera")`.
 */
export function privacyPanel(): Panel {
  const p = panel(
    "privacy",
    "privacy",
    "The OS privacy decision for the microphone: what it is, how to ask, and what to do when the answer is no.",
  );

  p.note(
    "This wants the microphone so it can show the real system prompt. Nothing is " +
      "recorded - asking is the whole demonstration. This is the OS decision, not a " +
      "Vantail permission: no config flag grants it, and none is needed to ask.",
  );

  p.row(
    p.button("status()", () => privacy.status("microphone")),
    p.button("request()", () => privacy.request("microphone")),
    p.button("openSettings()", () => privacy.openSettings()),
  );

  p.row(
    p.button("guided: status, then ask if needed", async () => {
      const before = await privacy.status("microphone");
      if (before.status !== "not-determined") {
        return `No prompt: the decision is already "${before.status}". ` +
          `Revoke it in System Settings to see the prompt again.`;
      }
      const answer = await privacy.request("microphone");
      if (answer.status === "authorized") {
        return "Granted - the OS prompt appeared and access was allowed.";
      }
      return (
        `The prompt appeared and the answer was "${answer.status}". ` +
        `Only System Settings can change it from here - openSettings() takes you there.`
      );
    }),
  );

  p.row(
    p.button("platform()", () => os.platform()),
    p.button("browser getUserMedia (WebKit path)", async () => {
      // The same TCC decision through the webview instead of the runtime: no
      // Vantail API involved, and the Info.plist description still required.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tracks = stream.getAudioTracks().map((track) => track.label || "(unnamed device)");
      stream.getTracks().forEach((track) => track.stop());
      return `Captured and released. Tracks: ${tracks.join(", ") || "none"}`;
    }),
  );

  p.note(
    "Denied means System Settings: Privacy & Security > Microphone. " +
      "Grants belong to the running app's identity, so `vantail dev` and the packaged " +
      ".app keep separate decisions - test the packaged build before concluding " +
      "anything. Off macOS every call answers UNSUPPORTED_PLATFORM or unsupported.",
  );

  return p;
}
