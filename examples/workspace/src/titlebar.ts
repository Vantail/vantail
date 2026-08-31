/**
 * The two heights this window's chrome is made of, and what the platform
 * reserved inside it.
 *
 * The design is two bands: a dark command bar, and a lighter tab strip under
 * it. Together they are the title bar - the page runs to the top edge and
 * there is no platform bar above them.
 *
 * `titleBarHeight` in `vantail.config.ts` is `COMMAND`, not `COMMAND + TABS`,
 * and that is the one thing worth getting right here. The runtime uses it to
 * place the platform's window buttons, so it is the height of the row those
 * buttons belong in - the top one. Passing the total would centre the traffic
 * lights across both bands, leaving them floating over the tab strip.
 */

import { titleBarMetrics, type TitleBarMetrics } from "@vantail/api";

/** The dark command bar. Matches `titleBarHeight` in the config. */
export const COMMAND = 48;
/** The tab strip under it. The runtime knows nothing about this one. */
export const TABS = 40;

export const NOTHING_RESERVED: TitleBarMetrics = {
  height: 0,
  insetLeft: 0,
  insetRight: 0,
  buttonTop: 0,
  buttonHeight: 0,
};

export function useTitleBar(): TitleBarMetrics {
  // Off the injected bridge, so there is nothing to await and nothing to hold
  // in state: it does not change for the life of this window.
  return titleBarMetrics() ?? NOTHING_RESERVED;
}

/**
 * Whether this application draws its own caption buttons.
 *
 * Where the platform reserved no room on the leading edge it drew no buttons
 * either. Measuring is a better test than checking the platform's name: it
 * stays right if a platform changes its mind, and it is also right in a
 * browser during `vite dev`, where there is no window at all.
 */
export const drawsOwnControls = (metrics: TitleBarMetrics) => metrics.insetLeft === 0;
