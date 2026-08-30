import type { MenuItem } from "@vantail/api";

/**
 * What the menu shows about the application's own state.
 *
 * One field here, but the shape is the point: a menu is a view of state like
 * anything else, and the moment two things draw it - the platform's copy and
 * the one the title bar draws - the only way they agree is by both being
 * built from the same place.
 */
export interface MenuState {
  wrap: boolean;
}

export const INITIAL_MENU_STATE: MenuState = { wrap: true };

/**
 * The application menu, in one file because two things need it.
 *
 * `vantail.config.ts` installs it as the platform's menu at startup. On macOS
 * that is the whole story - the menu bar is the system's, sits at the top of
 * the screen, and a hidden title bar does not touch it.
 *
 * Windows and Linux hang the menu off the window frame, and
 * `titleBarStyle: "hidden"` is an undecorated window. The menu is still
 * installed and its accelerators still fire; there is simply no frame left
 * for it to appear in. So `MenuBar.tsx` draws the titles and opens the
 * platform's own menu under them, which is what every editor on Windows does.
 *
 * A function rather than a constant because of the checkbox. Each popup
 * builds a fresh native menu, so a `checked` baked in as a literal would come
 * back on every time it opened, however often it had been toggled.
 */
export function appMenu(state: MenuState = INITIAL_MENU_STATE): MenuItem[] {
  return [
    {
      type: "submenu",
      label: "File",
      items: [
        { id: "open", label: "Open...", accelerator: "CmdOrCtrl+O" },
        {
          type: "checkbox",
          id: "wrap",
          label: "Wrap long lines",
          checked: state.wrap,
        },
        { type: "separator" },
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
      items: [
        { type: "predefined", item: "about" },
      ],
    },

  ];
}
