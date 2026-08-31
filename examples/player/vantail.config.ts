import { defineConfig } from "@vantail/cli";

import { appMenu } from "./src/menu.js";
import { MIN_HEIGHT, MIN_WIDTH } from "./src/window.js";

export default defineConfig({
  app: {
    name: "Player",
    identifier: "dev.vantail.example.player",
    version: "0.1.0",
    icon: "icon.png",
  },

  window: {
    title: "Player",
    width: 1180,
    height: 760,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,

    // The whole point of this example. The page runs to the top edge of the
    // window and draws its own bar; `titleBarHeight` is what gets the
    // platform's window buttons centred in a bar that tall instead of left up
    // in the corner where a 28pt one would have put them.
    titleBarStyle: "hidden",
    titleBarHeight: 64,

    // Nudged in from the platform's 9 to sit under the taller bar's padding.
    // No `y`: they stay centred in whatever height the bar is.
    trafficLightPosition: { x: 18 },

    // What shows before the page has painted. Matched to the bar so a fast
    // resize does not open a pale gap down the side.
    backgroundColor: "#000000",
  },

  // On macOS these are what make Cmd-C, Cmd-V and Cmd-Q work at all.
  menu: appMenu(),

  permissions: {
    // `menu.popup` and `menu.onClick` are the API, and the API is gated. The
    // menu installed above is the runtime's own doing and needs nothing; the
    // button in the title bar that opens it does.
    menu: true,
  },
});
