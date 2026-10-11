import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "Invoice Printer",
    identifier: "dev.vantail.invoice",
    version: "0.1.0",
    icon: "icon.png",
  },

  window: {
    title: "Invoice Printer",
    width: 760,
    height: 640,
  },

  permissions: {
    // Printing itself needs no permission: the native dialog is the
    // authorisation. This scope exists only for the secondary demo path,
    // which prints the bundled sample PDF - and that *is* a file read, so
    // it goes through the read scope like any other.
    filesystem: {
      read: ["$RESOURCE/**"],
    },
  },
});
