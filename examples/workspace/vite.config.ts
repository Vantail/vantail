import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `vantail dev` adds the Vantail plugin itself - this file is only for what
// the interface needs.
export default defineConfig({ plugins: [react()] });
