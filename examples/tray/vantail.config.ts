import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "Focus",
    identifier: "dev.vantail.example.tray",
    version: "0.1.0",
    icon: "icon.png",
  },

  /**
   * No Dock icon, no Cmd-Tab entry. macOS only, and the reason this is an
   * application you find in the menu bar rather than one you switch to.
   *
   * It has to be set before the event loop runs, so it is config rather than
   * something the page can turn on later.
   */
  showInDock: false,

  /**
   * Closing the popover is not quitting.
   *
   * Without this the application would end the first time the window was
   * hidden - taking the menu bar icon, and the running timer, with it.
   */
  quitOnLastWindowClosed: false,

  window: {
    title: "Focus",
    // Matches `SIZE` in `src/popover.ts`; the popover is positioned by hand
    // and needs to know how big it is.
    width: 260,
    height: 320,

    // A panel, not a window: no frame, above other applications, and not
    // resizable. Keeping it out of the taskbar is a method rather than a
    // setting, so `src/main.ts` does that part.
    decorations: false,
    resizable: false,
    alwaysOnTop: true,

    // Rounded corners and a shadow are drawn by the page, which needs the
    // window behind it to be see-through - see `src/style.css`.
    transparent: true,

    // Nothing appears at launch. The first time this window is shown is when
    // the icon is clicked, and by then it has been moved under the icon.
    visible: false,

    // The close button is gone with the decorations, but Cmd-W still reaches
    // the window. Hiding rather than closing keeps the application alive and
    // the popover reusable.
    closeBehavior: "hide",
  },

  /**
   * The icon is created in `src/menubar.ts` rather than here.
   *
   * A tray icon declared in config exists before the page loads, which is
   * usually what you want - but this one's menu shows the timer's state, and
   * there is no state until the page runs. Setting it once from the page
   * keeps a single description of the menu instead of two that must agree.
   */

  // On macOS the predefined items are what make Cmd-Q work at all. There is
  // no menu bar to show them in while the app is an accessory, but the
  // shortcuts still need somewhere to live.
  menu: [
    {
      type: "submenu",
      label: "Focus",
      items: [
        { type: "predefined", item: "about" },
        { type: "separator" },
        { type: "predefined", item: "quit" },
      ],
    },
  ],

  permissions: {
    tray: true,
    notification: true,
  },
});
