import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "Vantail Symbols",
    identifier: "dev.vantail.symbols",
    // A square PNG. Every size each platform asks for is scaled down from it.
    icon: "icon.png",
  },

  window: {
    // An application layout with its own scroll regions (sidebar, icon grid,
    // inspector), not a scrolling document - so the window itself does not
    // scroll.
    title: "Vantail Symbols",
    width: 1220,
    height: 780,
    minWidth: 960,
    minHeight: 600,
  },

  // Clipboard write is the only native capability this app needs: every copy
  // button funnels through `clipboard.writeText`, with a web-clipboard
  // fallback when running outside Vantail. Favorites and recents live in
  // `localStorage`, which needs no permission.
  permissions: {
    clipboard: true,
  },
});
