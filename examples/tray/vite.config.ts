import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// `vantail dev` adds the Vantail plugin itself - this file is only for what
// the interface needs.
export default defineConfig({ plugins: [vue()] });
