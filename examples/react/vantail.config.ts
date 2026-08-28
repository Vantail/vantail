import { defineConfig } from "@vantail/cli";

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
    minWidth: 560,
    minHeight: 420,
    // This example draws its own title bar - see `src/TitleBar.tsx`. The
    // height is left to the platform; the app can ask for a taller one at
    // runtime, and the traffic lights follow.
    titleBarStyle: "hidden",
  },

  // On macOS this is what makes Cmd-C, Cmd-V and Cmd-Z work at all - without
  // the predefined items present, the shortcuts do nothing anywhere in the
  // app. Worth setting even if you never show a custom menu.
  menu: [
    {
      type: "submenu",
      label: "Vantail Example",
      items: [
        { type: "predefined", item: "about" },
        { type: "separator" },
        { id: "settings", label: "Settings...", accelerator: "CmdOrCtrl+," },
        { type: "separator" },
        { type: "predefined", item: "hide" },
        { type: "predefined", item: "quit" },
      ],
    },
    {
      type: "submenu",
      label: "File",
      items: [
        { id: "open", label: "Open...", accelerator: "CmdOrCtrl+O" },
        {
          type: "checkbox",
          id: "wrap",
          label: "Wrap long lines",
          checked: true,
        },
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
