import type { MenuItem } from "@vantail/api";

/**
 * The application menu, in one file because two things need it.
 *
 * `vantail.config.ts` installs it as the platform's menu at startup. On macOS
 * that is the whole story - the menu bar is the system's, sits at the top of
 * the screen, and a hidden title bar does not touch it.
 *
 * Windows and Linux hang the menu off the window frame, and
 * `titleBarStyle: "hidden"` is an undecorated window. The menu is still
 * installed and its accelerators still fire; there is simply no frame left for
 * it to appear in. So `MenuBar.tsx` draws the titles and opens the platform's
 * own menu under them.
 */
export function appMenu(): MenuItem[] {
  return [
    {
      type: "submenu",
      label: "File",
      items: [
        { id: "settings", label: "Settings...", accelerator: "CmdOrCtrl+," },
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
      label: "Help",
      items: [{ type: "predefined", item: "about" }],
    },
  ];
}
