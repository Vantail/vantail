/**
 * A menu bar application.
 *
 * The shape is the point of this example: there is no Dock icon, no taskbar
 * entry and no window most of the time. What runs is the icon in the menu
 * bar, and the window is a popover it opens under itself.
 *
 * Four settings in `vantail.config.ts` make that possible, and none of them
 * is about the interface:
 *
 *   `showInDock: false`              no Dock icon, no Cmd-Tab entry
 *   `quitOnLastWindowClosed: false`  closing the popover is not quitting
 *   `window.visible: false`          nothing appears at launch
 *   `window.decorations: false`      a panel rather than a window
 */

import { createApp } from "vue";

import App from "./App.vue";
import { announce, command, install, items, menuState, onMenu, paint } from "./menubar.js";
import { closeOnBlur, toggle } from "./popover.js";
import { run } from "./timer.js";
import { appWindow, tray } from "@vantail/api";

import "./style.css";

createApp(App).mount("#app");

// The icon exists before anything else does. If this failed the application
// would be invisible and unquittable, so it is worth being loud about.
await install().catch((error: unknown) => {
  console.error("could not create the tray icon", error);
});

// `showInDock` covers macOS; this is the same idea on Windows and Linux,
// where a popover has no business appearing in the task switcher.
await appWindow.setSkipTaskbar(true).catch(() => {});

closeOnBlur();

// The click carries where the icon is, which is the only way to know: it
// moves as other applications come and go.
tray.onClick(({ x, y }) => {
  void toggle(x, y);
});

onMenu((id) => command(id));

// One clock for the whole application.
//
// The popover and the menu bar are painted from the same tick, so they cannot
// disagree about the time - they used to have an interval each, a second
// apart, and showed different numbers. The menu is rebuilt only when what it
// says would change, which no longer includes the clock.
let shownMenu = menuState();

run({
  onTick: () => {
    void paint();
    const state = menuState();
    if (state === shownMenu) return;
    shownMenu = state;
    void tray.setMenu(items());
  },
  onFinish: (finished) => void announce(finished),
});

