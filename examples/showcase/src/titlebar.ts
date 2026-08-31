import { appWindow, titleBarMetrics, type TitleBarStyle } from "@vantail/api";

/**
 * The title bar this app draws when the platform's is hidden.
 *
 * The whole thing is driven by the CSS variables the runtime sets, so nothing
 * here knows how tall a title bar is or how much room the traffic lights
 * need - which is the point. Switching styles changes those variables and
 * this resizes with them.
 */
export function mountTitleBar(): void {
  const bar = document.getElementById("titlebar");
  if (!bar) return;

  bar.innerHTML =
    '<span class="tb-buttons"><button type="button">&#8592;</button>' +
    '<button type="button">&#8594;</button></span>' +
    '<span class="tb-search">Vantail Showcase</span>';

  // Nothing wires up dragging. The runtime moves the window from the band a
  // hidden title bar left behind and skips the controls in it, so this bar
  // drags without a listener - and so does a page that draws no bar at all.
  // `appWindow.startDragging()` is still there for a region of your own
  // choosing; see the window panel.

  applyTitleBar();
}

/**
 * Switch this window's title bar, and let the layout follow.
 *
 * `setTitleBarStyle` has already updated the CSS variables by the time it
 * resolves, so all that is left is to say which arrangement is on.
 */
export async function switchTitleBar(style: TitleBarStyle) {
  const metrics = await appWindow.setTitleBarStyle(style);
  applyTitleBar();
  return metrics;
}

/**
 * Ask for a taller bar, or `null` for the platform's own height.
 *
 * Nothing here has to move the traffic lights - the runtime re-centres them
 * in whatever height it is given, and the CSS variable follows.
 */
export async function resizeTitleBar(height: number | null) {
  const metrics = await appWindow.setTitleBarHeight(height);
  applyTitleBar();
  return metrics;
}

/**
 * Show the app's own bar only when there is no platform one.
 *
 * A height of zero means the window has a real title bar, so there is nothing
 * to draw and nothing to leave room for.
 */
function applyTitleBar(): void {
  const metrics = titleBarMetrics();
  const hidden = (metrics?.height ?? 0) > 0;
  document.documentElement.dataset.titlebar = hidden ? "hidden" : "default";

  // Windows and Linux lose the system buttons with the bar, so an app has to
  // draw its own. `insetLeft` is zero exactly when nothing was reserved.
  document.documentElement.dataset.ownControls =
    hidden && (metrics?.insetLeft ?? 0) === 0 ? "yes" : "no";
}
