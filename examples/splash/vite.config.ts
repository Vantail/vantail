import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `vantail dev` adds the Vantail plugin itself - this file is only for what
// the interface needs. Two windows means two HTML entry points, so Rollup has
// to be told about the second one.
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // The `@/...` specifier shadcn's components import each other by. The type
  // checker learns it from `tsconfig.json`; this is the half that makes the
  // bundle build.
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "src") },
  },

  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        app: resolve(import.meta.dirname, "app.html"),
      },
    },
  },
});
