import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "Threads",
    identifier: "dev.vantail.example.sidebar",
    version: "0.1.0",
    icon: "icon.png",
  },

  window: {
    title: "Threads",
    width: 1000,
    height: 680,
    minWidth: 560,
    minHeight: 420,

    // The page runs to the top edge and draws its own bar - except that here
    // there is no bar element. The two columns run the full height of the
    // window and the "bar" is their top 52px, which is what makes the sidebar
    // look like one piece rather than a strip laid over it.
    titleBarStyle: "hidden",
    titleBarHeight: 52,

    // Nudged right of the default so they sit in from the sidebar's edge by
    // about as much as its content is.
    trafficLightPosition: { x: 16 },

    // What shows before the page has painted. Matched to the content column
    // rather than the sidebar: it is the larger of the two, so a fast resize
    // exposes it more often.
    backgroundColor: "#1c1f26",
  },

  menu: [
    {
      type: "submenu",
      label: "Threads",
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
    {
      type: "submenu",
      label: "View",
      items: [
        // The shortcut lives on a menu item rather than a key listener so it
        // works while focus is on a control, and so it is discoverable.
        {
          type: "normal",
          id: "toggle-sidebar",
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+\\",
        },
      ],
    },
  ],

  permissions: {
    menu: true,
  },
});
