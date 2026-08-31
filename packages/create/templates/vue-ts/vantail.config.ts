import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "__APP_NAME__",
    identifier: "__APP_IDENTIFIER__",
    version: "0.1.0",
    // A square PNG. Every size each platform asks for is scaled down from it.
    icon: "icon.png",
  },

  window: {
    // This starter is a page: it shows a file's contents, which can be
    // longer than the window. A Vantail window is a fixed frame by default -
    // it does not scroll - so it says otherwise. Delete this once the layout
    // is panes that scroll on their own.
    scroll: true,

    title: "__APP_NAME__",
    width: 900,
    height: 640,
    minWidth: 480,
    minHeight: 360,
  },

  // On macOS this is not decoration: without these predefined items in the
  // menu, Cmd-C, Cmd-V and Cmd-Z do not work anywhere in the application.
  // Add your own submenus alongside them.
  menu: [
    {
      type: "submenu",
      label: "__APP_NAME__",
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

  // Everything is denied until you ask for it. Start small: `dialog` plus the
  // default `grantFromDialog` is enough to open any file the user picks,
  // without granting standing access to their disk.
  permissions: {
    dialog: true,
    clipboard: true,
    menu: true,
    filesystem: {
      write: ["$APPDATA/**"],
    },
  },
});
