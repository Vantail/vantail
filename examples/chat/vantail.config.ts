import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "Assistant",
    identifier: "dev.vantail.example.chat",
    version: "0.1.0",
    icon: "icon.png",
  },

  window: {
    title: "Assistant",
    width: 900,
    height: 680,
    minWidth: 480,
    minHeight: 420,

    // The page runs to the top edge of the window and draws its own bar - see
    // the header in `src/views.ts`. `titleBarHeight` is what gets the
    // platform's window buttons centred in a bar that tall.
    titleBarStyle: "hidden",
    titleBarHeight: 52,

    // What shows before the page has painted, so a fast resize does not open
    // a pale gap down the side.
    backgroundColor: "#0b0d12",
  },

  menu: [
    {
      type: "submenu",
      label: "Assistant",
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
    /**
     * The compiled server, shipped inside the bundle.
     *
     * `$RESOURCE` is the directory the packaged assets land in, so this names
     * the binary `bun build --compile` wrote into `dist/`. Development never
     * reaches this rule - there the window points straight at a server that is
     * already running.
     *
     * No arguments are allowed at all: `args: []` is a rule per position, and
     * there are no positions.
     */
    shell: {
      allow: [{ program: "$RESOURCE/server", args: [] }],
    },
  },
});
