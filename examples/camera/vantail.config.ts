import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "Camera",
    identifier: "dev.vantail.example.camera",
    version: "0.1.26",
    // A square PNG. Every size each platform asks for is scaled down from it.
    icon: "icon.png",
  },

  window: {
    title: "Camera",
    width: 860,
    height: 700,
    minWidth: 520,
    minHeight: 480,
  },

  // The string behind the macOS camera prompt. Without it the OS denies
  // capture without ever asking - see `docs/macos-privacy.md`. It grants
  // nothing; it lets the OS ask.
  macos: {
    cameraUsageDescription:
      "This example shows the camera permission prompt and a live preview. Nothing is recorded.",
  },

  // Nothing to grant: `privacy.*` needs no Vantail permission - the OS prompt
  // is the gate, not the config. The preview itself is the webview's own
  // `getUserMedia`, not a runtime API.
});
