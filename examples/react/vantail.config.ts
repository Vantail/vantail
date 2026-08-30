import { defineConfig } from "@vantail/cli";

import { appMenu } from "./src/menu.js";
import { MIN_HEIGHT, MIN_WIDTH } from "./src/window.js";

export default defineConfig({
  app: {
    name: "Vantail Example",
    identifier: "dev.vantail.example",
    version: "0.1.0",
    // A square PNG. Every size each platform asks for is scaled down from it.
    icon: "icon.png",
  },

  window: {
    title: "Vantail Example",
    width: 980,
    height: 700,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // This example draws its own title bar - see `src/TitleBar.tsx`. The
    // height is its own, and `titleBarHeight` tells the runtime so the
    // platform's window buttons are centred in it rather than left up at the
    // top where a 28pt bar would have put them.
    // What shows before the page has painted - matched to the app's own
    // background so a live resize does not leave a pale gap down the side.
    backgroundColor: "#14121a",
    titleBarStyle: "hidden",
    titleBarHeight: 44,
    trafficLightPosition: { x: 14 },
  },

  // On macOS this is what makes Cmd-C, Cmd-V and Cmd-Z work at all - without
  // the predefined items present, the shortcuts do nothing anywhere in the
  // app. Worth setting even if you never show a custom menu.
  //
  // The items live in `src/menu.ts` because the interface needs them too:
  // this installs the platform's menu, and on the platforms where a hidden
  // title bar leaves that menu nowhere to appear, `MenuBar.tsx` draws the
  // same array. The config is loaded through esbuild, so a relative import
  // here is bundled rather than resolved at runtime.
  menu: appMenu(),

  permissions: {
    dialog: true,
    shortcut: true,
    dragDrop: true,
    clipboard: true,
    menu: true,
    tray: true,

    filesystem: {
      // Nothing under $HOME is readable by default - but `grantFromDialog`
      // (on by default) means anything the user picks in a dialog is. That is
      // the pattern worth copying: let the user's choice be the permission,
      // and keep the standing scope as small as the app can live with.
      read: ["$DOCUMENT/**", "$RESOURCE/**"],
      write: ["$APPDATA/**"],
    },

    // One program, with its arguments pinned. There is no shell involved, so
    // there is nothing for an argument to inject into - but the narrower the
    // rule, the less an injected script could do with it.
    shell: {
      allow: [{ program: "/usr/bin/uptime", args: [] }],
    },
  },
});
