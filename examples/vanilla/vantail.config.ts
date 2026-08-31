import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "Vantail Vanilla",
    identifier: "dev.vantail.vanilla",
    version: "0.1.0",
    // A square PNG. Every size each platform asks for is scaled down from it.
    icon: "icon.png",
  },

  window: {
    // The simplest possible window, and its content is a document
    // rather than a set of panes - so it scrolls like one.
    scroll: true,

    title: "Vantail Vanilla",
    width: 900,
    height: 640,
    minWidth: 480,
    minHeight: 360,
  },

  // Everything is denied until you ask for it. Start small: `dialog` plus the
  // default `grantFromDialog` is enough to open any file the user picks,
  // without granting standing access to their disk.
  permissions: {
    dialog: true,
    clipboard: true,
    filesystem: {
      write: ["$APPDATA/**"],
    },
  },
});
