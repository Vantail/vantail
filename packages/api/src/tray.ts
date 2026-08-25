import { normalize, type MenuItem } from "./menu.js";
import { invoke, listen } from "./transport.js";

export interface TrayOptions {
  /** PNG path. Relative paths resolve inside the application's resources. */
  icon?: string;
  tooltip?: string;
  /** Text beside the icon. macOS only. */
  title?: string;
  /**
   * Render the icon as a monochrome template. On macOS this is what makes it
   * invert correctly against a dark menu bar - usually what you want.
   */
  iconAsTemplate?: boolean;
  menu?: MenuItem[];
  /**
   * What a left click on the icon does. A right click always opens the menu.
   *
   * - `showWindow` (default) - bring the window back if it is hidden, focus
   *   it if it is behind something, and open the menu if it is already in
   *   front. Which is what a tray icon is usually for.
   * - `menu` - always open the menu, the older macOS convention.
   * - `event` - do nothing but fire {@link tray.onClick}.
   */
  leftClick?: "showWindow" | "menu" | "event";
  /** Which window `showWindow` brings back. `main` by default. */
  window?: string;
}

export interface TrayClick {
  button: string;
  /** Screen coordinates, in physical pixels. */
  x: number;
  y: number;
}

/**
 * The menu bar / system tray icon.
 *
 * An application that wants to keep running with no window open should also
 * set `quitOnLastWindowClosed: false` in its config - otherwise closing the
 * window takes the tray icon with it.
 */
export const tray = {
  /** Create the tray icon, or replace the one that is there. */
  set: (options: TrayOptions) =>
    invoke<null>("tray.set", {
      ...options,
      ...(options.menu ? { menu: normalize(options.menu) } : {}),
    }),

  remove: () => invoke<null>("tray.remove"),
  exists: () => invoke<boolean>("tray.exists"),

  setIcon: (icon: string, options: { template?: boolean } = {}) =>
    invoke<null>("tray.setIcon", { icon, ...options }),
  setTooltip: (tooltip: string | null) =>
    invoke<null>("tray.setTooltip", { tooltip }),
  /** macOS only; ignored elsewhere. */
  setTitle: (title: string | null) => invoke<null>("tray.setTitle", { title }),
  setVisible: (visible: boolean) =>
    invoke<null>("tray.setVisible", { visible }),
  setMenu: (items: MenuItem[]) =>
    invoke<null>("tray.setMenu", { items: normalize(items) }),

  /** Open the tray menu without waiting for a click on the icon. */
  showMenu: () => invoke<null>("tray.showMenu"),

  onClick: (handler: (event: TrayClick) => void) =>
    listen<TrayClick>("tray.click", handler),
  /** Windows only. */
  onDoubleClick: (handler: (event: TrayClick) => void) =>
    listen<TrayClick>("tray.doubleClick", handler),
};
