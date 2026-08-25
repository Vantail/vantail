import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// `vantail dev` adds the Vantail plugin itself - this file is only for what
// your interface needs.
export default defineConfig({
  plugins: [svelte()],
});
