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
 * it to appear in. So `MenuBar.tsx` puts one button in the title bar and hands
 * this whole array to `menu.popup`, which draws the titles as a list and their
 * items as submenus off it.
 */

export const SETTINGS = "settings";
export const PLAY = "play";
export const NEXT = "next";
export const PREVIOUS = "previous";
export const SHUFFLE = "shuffle";
export const REPEAT = "repeat";
export const QUEUE = "queue";
export const FULLSCREEN = "fullscreen";

/** What the checkable items should show. */
export interface Playback {
  shuffle: boolean;
  repeat: boolean;
}

export function appMenu(playback: Playback = { shuffle: false, repeat: false }): MenuItem[] {
  return [
    {
      type: "submenu",
      label: "File",
      items: [
        { id: SETTINGS, label: "Settings...", accelerator: "CmdOrCtrl+," },
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
        { id: QUEUE, label: "Queue", accelerator: "CmdOrCtrl+Shift+Q" },
        { type: "separator" },
        { id: FULLSCREEN, label: "Full Screen", accelerator: "F11" },
      ],
    },
    {
      type: "submenu",
      label: "Playback",
      items: [
        { id: PLAY, label: "Play", accelerator: "Space" },
        { id: NEXT, label: "Next", accelerator: "CmdOrCtrl+Right" },
        { id: PREVIOUS, label: "Previous", accelerator: "CmdOrCtrl+Left" },
        { type: "separator" },
        // Checkboxes, because these are states rather than actions. A menu is
        // a snapshot of the moment it was built, so the values come in from
        // `App.tsx` and the menu is rebuilt when they change - otherwise the
        // ticks would go back to whatever this file happened to say.
        { type: "checkbox", id: SHUFFLE, label: "Shuffle", checked: playback.shuffle },
        { type: "checkbox", id: REPEAT, label: "Repeat", checked: playback.repeat },
      ],
    },
    {
      type: "submenu",
      label: "Help",
      items: [{ type: "predefined", item: "about" }],
    },
  ];
}
