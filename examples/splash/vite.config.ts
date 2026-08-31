import { resolve } from "node:path";

import { defineConfig } from "vite";

// `vantail dev` adds the Vantail plugin itself - this file is only for what
// the interface needs. Two windows means two HTML entry points, so Rollup has
// to be told about the second one.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        app: resolve(import.meta.dirname, "app.html"),
      },
    },
  },
});
