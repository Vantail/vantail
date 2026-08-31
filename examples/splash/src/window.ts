/**
 * The application window's own numbers: how big it may be, how tall it draws
 * its title bar, and how much room the platform left it up there.
 *
 * Two different questions live here and they are easy to confuse:
 *
 *   `BAR_HEIGHT`    how tall *this application* draws its bar. A plain number,
 *                   the same on all three platforms, because with the
 *                   platform's bar hidden the page runs to the top edge of the
 *                   window and a bar is however many pixels the design says.
 *
 *   `useTitleBar()` how much room the *platform* reserved up there. macOS
 *                   keeps its traffic lights when the title bar is hidden, so
 *                   it reserves a leading inset; Windows and Linux keep
 *                   nothing and reserve nothing, which is the signal that the
 *                   application has to draw the buttons itself.
 */

import { titleBarMetrics, type TitleBarMetrics } from "@vantail/api";

/** A platform that reserved nothing, and the shape to fall back to. */
export const NOTHING_RESERVED: TitleBarMetrics = {
  height: 0,
  insetLeft: 0,
  insetRight: 0,
  buttonTop: 0,
  buttonHeight: 0,
};

/**
 * How tall the application window's bar is.
 *
 * Passed to `createWindow` as `titleBarHeight` as well as used for the layout,
 * so the runtime can re-centre the traffic lights in a bar this tall instead
 * of leaving them where a 28pt one would have put them. One constant, both
 * jobs - see `SplashScreen.tsx` for the other end of it.
 */
export const BAR_HEIGHT = 44;

/** The floor the application window is not allowed below. */
export const MIN_WIDTH = 520;
export const MIN_HEIGHT = 400;

/**
 * What the platform left behind, off the injected bridge.
 *
 * Not state and not an effect: the runtime writes these before the page lays
 * out, and this window never changes its title bar afterwards, so the first
 * render is already the right one.
 */
export function useTitleBar(): TitleBarMetrics {
  return titleBarMetrics() ?? NOTHING_RESERVED;
}

/**
 * Whether this application has to draw its own window controls.
 *
 * Where the platform reserved no room on the leading edge, it drew no buttons
 * either. Measuring is a better test than checking the platform's name: it
 * stays right if a platform changes its mind.
 */
export const drawsOwnControls = (metrics: TitleBarMetrics) => metrics.insetLeft === 0;
