import type { MenuItem } from "@vantail/api";

/**
 * The application menu, in one file because two things need it.
 *
 * `vantail.config.ts` installs it as the platform's menu at startup. On macOS
 * that is the whole story - the menu bar is the system's and a hidden title
 * bar does not touch it.
 *
 * Windows and Linux hang the menu off the window frame, and
 * `titleBarStyle: "hidden"` is an undecorated window. The menu is still
 * installed and its accelerators still fire; there is simply no frame left for
 * it to appear in. So `MenuBar.tsx` draws the titles and opens the platform's
 * own menu under them - which is exactly what an editor with tabs in its
 * title bar does on Windows.
 *
 * Cmd-W and Cmd-T live here rather than as key handlers in the page. On macOS
 * the menu bar is what makes a shortcut real: it shows the user the key, it
 * works when focus is in a text field, and the system will not quietly hand
 * Cmd-W to the window instead. `App.tsx` hears about them by `id`.
 */
export function appMenu(): MenuItem[] {
  return [
    {
      type: "submenu",
      label: "File",
      items: [
        { id: "new-tab", label: "New Tab", accelerator: "CmdOrCtrl+T" },
        { id: "close-tab", label: "Close Tab", accelerator: "CmdOrCtrl+W" },
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
