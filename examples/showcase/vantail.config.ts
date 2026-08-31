import { defineConfig } from "@vantail/cli";

/**
 * Every permission Vantail has, turned on.
 *
 * This is deliberately the opposite of what an application should do. It is
 * here so one app can demonstrate the whole API; a real config asks for the
 * few things it actually uses, because anything granted here is something a
 * compromised page could reach.
 */
export default defineConfig({
  app: {
    name: "Vantail Showcase",
    identifier: "dev.vantail.showcase",
    version: "0.1.0",
    icon: "icon.png",
  },

  window: {
    // This one really is a page: a long column of panels, and the
    // document is what scrolls through them.
    scroll: true,

    title: "Vantail Showcase",
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 520,
  },

  // What makes `vantail-showcase://anything` reach the deep link panel. The
  // association is registered with the OS by `vantail package`, so it works
  // from an installed build rather than from `vantail dev`.
  protocols: ["vantail-showcase"],

  menu: [
    {
      type: "submenu",
      label: "Vantail Showcase",
      items: [
        { type: "predefined", item: "about" },
        { type: "separator" },
        { type: "predefined", item: "hide" },
        { type: "predefined", item: "quit" },
      ],
    },
    {
      type: "submenu",
      label: "Edit",
      items: [
        { type: "predefined", item: "undo" },
        { type: "predefined", item: "redo" },
        { type: "separator" },
        { type: "predefined", item: "cut" },
        { type: "predefined", item: "copy" },
        { type: "predefined", item: "paste" },
        { type: "predefined", item: "selectAll" },
      ],
    },
  ],

  permissions: {
    dialog: true,
    clipboard: true,
    menu: true,
    tray: true,
    notification: true,
    shortcut: true,
    autostart: true,
    dragDrop: true,
    updater: true,
    secrets: true,

    // `true` means any service type. Naming the ones you want is the better
    // habit: "find me printers" is a smaller request than "watch the network".
    mdns: true,

    // Likewise, `true` here allows any USB HID device. A real app names the
    // vendor it ships hardware for.
    hid: true,

    filesystem: {
      // Still narrow, even here. Anything the user picks in a dialog is
      // granted for the session on top of this, which is the pattern worth
      // copying rather than widening these globs.
      read: ["$DOCUMENT/**", "$RESOURCE/**", "$TEMP/**"],
      write: ["$APPDATA/**", "$TEMP/**"],
    },

    shell: {
      allow: [{ program: "/bin/echo" }],
      open: ["https://*"],
    },

    // The capability; `filesystem.write` below is still what says where a
    // database may live.
    database: true,

    network: {
      // A bare host covers every scheme, so `echo.websocket.org` is reachable
      // over both https and wss with one rule.
      allow: ["example.com", "api.github.com", "echo.websocket.org"],
    },
  },
});
