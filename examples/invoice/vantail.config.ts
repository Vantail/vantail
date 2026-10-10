import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "Invoice Printer",
    identifier: "dev.vantail.invoice",
    version: "0.1.0",
  },

  window: {
    title: "Invoice Printer",
    width: 720,
    height: 620,
  },

  permissions: {
    // Printing itself needs no flag - the native dialog is the authorisation.
    // The generated PDF is a file being written and then read back, so temp
    // needs both sides of the scope, like any other read and write.
    filesystem: {
      read: ["$TEMP/**"],
      write: ["$TEMP/**"],
    },
  },
});
