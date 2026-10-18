import { privacy, VantailError, type PrivacyStatus } from "@vantail/api";

import "./style.css";

const badge = document.querySelector<HTMLSpanElement>("#badge")!;
const message = document.querySelector<HTMLParagraphElement>("#message")!;
const errorLine = document.querySelector<HTMLParagraphElement>("#error")!;
const video = document.querySelector<HTMLVideoElement>("#preview")!;
const hint = document.querySelector<HTMLParagraphElement>("#hint")!;

const checkButton = document.querySelector<HTMLButtonElement>("#check")!;
const askButton = document.querySelector<HTMLButtonElement>("#ask")!;
const settingsButton = document.querySelector<HTMLButtonElement>("#settings")!;
const startButton = document.querySelector<HTMLButtonElement>("#start")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;

let stream: MediaStream | null = null;

checkButton.addEventListener("click", () => {
  void refresh();
});
askButton.addEventListener("click", () => {
  void guidedRequest();
});
settingsButton.addEventListener("click", () => {
  void openSettings();
});
startButton.addEventListener("click", () => {
  void startPreview();
});
stopButton.addEventListener("click", () => {
  stopPreview();
});

void refresh();

function setStatus(status: PrivacyStatus, detail: string): void {
  badge.textContent = status;
  badge.className = `badge ${status}`;
  message.textContent = detail;
}

function showError(cause: unknown): void {
  errorLine.hidden = false;
  errorLine.textContent = VantailError.is(cause)
    ? `${cause.code}: ${cause.message}`
    : String(cause);
}

function clearError(): void {
  errorLine.hidden = true;
  errorLine.textContent = "";
}

/** The current decision, without prompting. Safe to call anywhere. */
async function refresh(): Promise<void> {
  clearError();
  try {
    const { status } = await privacy.status("camera");
    setStatus(status, describe(status));
  } catch (cause) {
    showError(cause);
  }
}

/**
 * Status first; ask only when there is something to ask. `request` shows the
 * system prompt the first time and answers from the stored decision after
 * that - so calling it when the answer is already known would never prompt.
 */
async function guidedRequest(): Promise<void> {
  clearError();
  try {
    const before = await privacy.status("camera");
    if (before.status !== "not-determined") {
      setStatus(
        before.status,
        `No prompt: the decision is already "${before.status}". ` +
          describe(before.status),
      );
      return;
    }
    const answer = await privacy.request("camera");
    setStatus(answer.status, describe(answer.status));
  } catch (cause) {
    showError(cause);
  }
}

async function openSettings(): Promise<void> {
  clearError();
  try {
    await privacy.openSettings();
  } catch (cause) {
    showError(cause);
  }
}

/**
 * The preview is the WebKit path, not the runtime: the same TCC decision
 * through `navigator.mediaDevices` instead of `privacy.*`. It still needs the
 * `cameraUsageDescription` in the packaged `Info.plist`, and on macOS it still
 * prompts when nothing has been decided yet - which is why this asks through
 * `privacy.request` first, so the prompt has exactly one owner.
 */
async function startPreview(): Promise<void> {
  clearError();
  try {
    const { status } = await privacy.status("camera");
    if (status !== "authorized") {
      setStatus(status, describe(status));
      if (status === "not-determined") {
        await guidedRequest();
        return;
      }
      return;
    }

    stopTracks();
    stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    await video.play();
    hint.textContent = "Live preview. Nothing is recorded.";
    startButton.disabled = true;
    stopButton.disabled = false;
  } catch (cause) {
    // A prompt answered "no" lands here as a DOMException, and a runtime
    // denial lands here as a VantailError - either way the preview stays off
    // and the status line says what to do next.
    if (cause instanceof DOMException) {
      await refresh();
    } else {
      showError(cause);
    }
  }
}

function stopPreview(): void {
  stopTracks();
  video.srcObject = null;
  hint.textContent = "Preview is off.";
  startButton.disabled = false;
  stopButton.disabled = true;
}

function stopTracks(): void {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
}

function describe(status: PrivacyStatus): string {
  switch (status) {
    case "not-determined":
      return "Never asked. Ask for access to show the system prompt.";
    case "authorized":
      return "Granted. Start the preview to see the camera.";
    case "denied":
      return "Denied. Only you can reverse it, in System Settings: Privacy & Security.";
    case "restricted":
      return "Restricted by policy (MDM / Screen Time). Neither you nor the app can change it here.";
    case "unsupported":
      return "No OS prompt on this platform. The preview may still work through the browser.";
  }
}
