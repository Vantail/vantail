import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "Tasks",
    identifier: "dev.vantail.tasks",
    version: "0.1.25",
    // A square PNG. Every size each platform asks for is scaled down from it.
    icon: "icon.png",
  },

  window: {
    title: "Tasks",
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 480,
  },

  // "Copy list" is the only native capability this app needs: everything
  // else is local UI state in `localStorage`, which needs no permission.
  permissions: {
    clipboard: true,
  },
});
