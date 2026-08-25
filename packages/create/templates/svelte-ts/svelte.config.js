import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  // What lets a component write `<script lang="ts">`.
  preprocess: vitePreprocess(),
};
