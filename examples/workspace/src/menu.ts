/**
 * The application menu.
 *
 * On macOS this is the menu bar, and it is not decoration: the predefined
 * items are what make Cmd-C, Cmd-V and Cmd-Z work at all. Cmd-T and Cmd-W
 * live here too rather than as key handlers in the page - on macOS the
 * shortcut only exists because a menu item claims it, and claiming Cmd-W here
 * is what stops the platform closing the whole window when the user meant to
 * close a tab.
 */

import type { MenuItem } from "@vantail/api";

export const NEW_TAB = "new-tab";
export const CLOSE_TAB = "close-tab";

export function appMenu(): MenuItem[] {
  return [
    {
      type: "submenu",
      label: "Workspace",
      items: [
        { type: "predefined", item: "about" },
        { type: "separator" },
        { type: "predefined", item: "hide" },
        { type: "predefined", item: "quit" },
      ],
    },
    {
      type: "submenu",
      label: "File",
      items: [
        { id: NEW_TAB, label: "New Tab", accelerator: "CmdOrCtrl+T" },
        { id: CLOSE_TAB, label: "Close Tab", accelerator: "CmdOrCtrl+W" },
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
  ];
}
