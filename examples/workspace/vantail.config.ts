import { defineConfig } from "@vantail/cli";

import { appMenu } from "./src/menu.js";
import { COMMAND } from "./src/titlebar.js";

export default defineConfig({
  app: {
    name: "Workspace",
    identifier: "dev.vantail.example.workspace",
    version: "0.1.0",
    icon: "icon.png",
  },

  window: {
    title: "Workspace",
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 420,

    // The page runs to the top edge and draws the whole chrome: a dark
    // command bar with a tab strip under it.
    titleBarStyle: "hidden",

    /**
     * The height of the **first** row, not of both.
     *
     * This is what the runtime places the platform's window buttons inside,
     * so it is the row those buttons belong in. Passing `COMMAND + TABS`
     * would centre the macOS traffic lights across the whole chrome, leaving
     * them floating over the tab strip instead of sitting in the dark bar.
     *
     * Imported from `src/titlebar.ts` so the two cannot drift: the config is
     * loaded through esbuild, so a relative import here is bundled rather
     * than resolved at runtime.
     */
    titleBarHeight: COMMAND,

    // In from the edge by about as much as the bar's own content is.
    trafficLightPosition: { x: 16 },

    // What shows before the page has painted. The command bar is at the top
    // where a resize exposes it first, so match that rather than the page.
    backgroundColor: "#0d0f12",
  },

  menu: appMenu(),

  permissions: {
    menu: true,
  },
});
