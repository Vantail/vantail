/**
 * What the platform reserved at the top of the window.
 *
 * The runtime injects these before the first paint and updates them when the
 * bar changes, so a layout built on them is right immediately rather than
 * after a round trip.
 *
 * The same numbers are on the document as CSS variables
 * (`--vantail-titlebar-inset-left` and friends), and a page that only needs
 * padding should use those - no JavaScript, correct before hydration. This
 * example reads them here as well because *which element* gets that padding
 * changes with the sidebar, and that is a decision CSS cannot make on its own.
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
 * How tall this application draws its bar. Its own decision, not the
 * platform's - the same on all three of them.
 */
export const BAR_HEIGHT = 52;

export function useTitleBar(): TitleBarMetrics {
  // Off the injected bridge, so there is nothing to await and nothing to put
  // in state: it does not change for the life of this window.
  return titleBarMetrics() ?? NOTHING_RESERVED;
}

/**
 * Whether this application has to draw its own window controls.
 *
 * Where the platform reserved no room on the leading edge it drew no buttons
 * either. Measuring is a better test than checking the platform's name: it
 * stays right if a platform changes its mind.
 */
export const drawsOwnControls = (metrics: TitleBarMetrics) => metrics.insetLeft === 0;
