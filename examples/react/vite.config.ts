import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `vantail dev` adds the Vantail plugin itself - this file is only for what
// your interface needs. A second window means a second HTML entry point, so
// Rollup has to be told about it.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        settings: resolve(import.meta.dirname, "settings.html"),
      },
    },
  },
});
