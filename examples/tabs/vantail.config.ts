import { defineConfig } from "@vantail/cli";

import { appMenu } from "./src/menu.js";
import { MIN_HEIGHT, MIN_WIDTH } from "./src/window.js";

export default defineConfig({
  app: {
    name: "Tabs",
    identifier: "dev.vantail.example.tabs",
    version: "0.1.0",
    icon: "icon.png",
  },

  window: {
    title: "Tabs",
    width: 1100,
    height: 720,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,

    // The tab strip *is* the title bar, which is the whole idea: the page runs
    // to the top edge of the window and draws the tabs up there itself.
    //
    // `titleBarHeight` is what gets the platform's window buttons centred in a
    // strip that tall - without it they stay up in the corner where a 28pt bar
    // would have put them, and the tabs sit below them looking detached.
    titleBarStyle: "hidden",
    titleBarHeight: 44,

    // What shows before the page has painted, so a fast resize does not open a
    // pale gap down the side of the strip.
    backgroundColor: "#1f2126",
  },

  // Cmd-W and Cmd-T are menu items rather than key handlers in the page.
  //
  // That is not ceremony. On macOS the menu bar is what makes a shortcut real:
  // it shows the user the key, it works when focus is in a text field, and the
  // system will not quietly hand Cmd-W to the window instead. The page hears
  // about them through `menu.onClick` by `id`.
  menu: appMenu(),

  permissions: {
    // `menu.onClick` is how the page hears about File > Close Tab.
    menu: true,
  },
});
