import { os, privacy, type PrivacyKind } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/**
 * macOS privacy (TCC): every kind the runtime can request.
 *
 * The microphone is the kind to try first - its prompt is straightforward and
 * denying it is harmless. The camera works the same way; screen recording
 * differs only in that the OS cannot tell "never asked" from "denied".
 */
export function privacyPanel(): Panel {
  const p = panel(
    "privacy",
    "privacy",
    "The OS privacy decisions: what they are, how to ask, and what to do when the answer is no.",
  );

  p.note(
    "This asks so it can show the real system prompts. Nothing is recorded, " +
      "photographed, or captured - asking is the whole demonstration. These are OS " +
      "decisions, not Vantail permissions: no config flag grants them, and none is " +
      "needed to ask.",
  );

  const kinds: { kind: PrivacyKind; why: string }[] = [
    { kind: "microphone", why: "to show the audio prompt" },
    { kind: "camera", why: "to show the video prompt" },
    { kind: "screen", why: "to show the screen-recording prompt" },
  ];

  for (const { kind, why } of kinds) {
    p.row(
      p.button(`${kind}: status()`, () => privacy.status(kind)),
      p.button(`${kind}: request()`, () => privacy.request(kind)),
      p.button(`${kind}: guided`, () => guided(kind, why)),
    );
  }

  p.row(p.button("openSettings()", () => privacy.openSettings()));

  p.row(
    p.button("platform()", () => os.platform()),
    p.button("browser audio (WebKit path)", async () => {
      // The same TCC decision through the webview instead of the runtime: no
      // Vantail API involved, and the Info.plist description still required.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tracks = stream.getAudioTracks().map((track) => track.label || "(unnamed device)");
      stream.getTracks().forEach((track) => track.stop());
      return `Captured and released. Tracks: ${tracks.join(", ") || "none"}`;
    }),
    p.button("browser video (WebKit path)", async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const tracks = stream.getVideoTracks().map((track) => track.label || "(unnamed device)");
      stream.getTracks().forEach((track) => track.stop());
      return `Captured and released. Tracks: ${tracks.join(", ") || "none"}`;
    }),
  );

  p.note(
    "Screen recording cannot report not-determined: a first-ever status reads as " +
      "denied until the prompt has been answered. Request it to find out which.",
  );
  p.note(
    "Denied means System Settings: Privacy & Security. Accessibility, location, " +
      "contacts and the rest have no prompt API for the runtime to call, so " +
      "openSettings() is the whole flow for those - see docs/macos-privacy.md.",
  );
  p.note(
    "Grants belong to the running app's identity, so `vantail dev` and the packaged " +
      ".app keep separate decisions - test the packaged build before concluding " +
      "anything. Off macOS every call answers UNSUPPORTED_PLATFORM or unsupported.",
  );

  return p;
}

/** Status first; ask only when there is something to ask. */
async function guided(kind: PrivacyKind, why: string): Promise<string> {
  const before = await privacy.status(kind);
  if (before.status !== "not-determined") {
    if (kind === "screen" && before.status === "denied") {
      // Indistinguishable from never-asked, so asking is still informative.
      const answer = await privacy.request(kind);
      return (
        `Screen recording read as "denied", which also means "never asked" - so the ` +
        `prompt ran anyway and the answer was "${answer.status}".`
      );
    }
    return `No prompt: the decision is already "${before.status}". ` +
      `Revoke it in System Settings to see the prompt again.`;
  }
  const answer = await privacy.request(kind);
  if (answer.status === "authorized") {
    return `Granted - the OS prompt appeared (${why}) and access was allowed.`;
  }
  return (
    `The prompt appeared and the answer was "${answer.status}". ` +
    `Only System Settings can change it from here - openSettings() takes you there.`
  );
}
