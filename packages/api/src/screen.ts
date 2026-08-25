import { invoke } from "./transport.js";

export interface Screen {
  /** What the operating system calls it, when it says anything. */
  name: string | null;
  /**
   * Where its top-left corner sits in the desktop coordinate space, in
   * logical pixels. A screen left of the primary one has a negative `x`.
   */
  position: { x: number; y: number };
  /** Its size in logical pixels - the same units window methods take. */
  size: { width: number; height: number };
  /** 2 on a Retina display, 1 on most others. */
  scaleFactor: number;
  primary: boolean;
}

/**
 * The displays a window can be put on.
 *
 * A page can see the screen it is on through `window.screen`, but not the
 * others, and not where they sit relative to each other - so
 * {@link appWindow.setPosition} is guesswork on a machine with two monitors
 * without this.
 *
 * Everything is in logical pixels, matching the window methods.
 *
 * ```ts
 * const { position, size } = await screen.current();
 * await appWindow.setPosition(
 *   position.x + (size.width - 900) / 2,
 *   position.y + (size.height - 640) / 2,
 * );
 * ```
 */
export const screen = {
  /** Every connected display. */
  list(): Promise<Screen[]> {
    return invoke<Screen[]>("screen.list");
  },

  /** The one the system considers primary, if it names one. */
  primary(): Promise<Screen | null> {
    return invoke<Screen | null>("screen.primary");
  },

  /** The one this window is currently on. */
  current(): Promise<Screen | null> {
    return invoke<Screen | null>("screen.current");
  },

  /** Whichever display contains a desktop coordinate, if any does. */
  fromPoint(x: number, y: number): Promise<Screen | null> {
    return invoke<Screen | null>("screen.fromPoint", { x, y });
  },
};
