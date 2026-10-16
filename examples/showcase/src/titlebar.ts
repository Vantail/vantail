import { appWindow, os, titleBarMetrics, type TitleBarStyle } from "@vantail/api";

/**
 * The title bar this app draws when the platform's is hidden.
 *
 * The whole thing is driven by the CSS variables the runtime sets, so nothing
 * here knows how tall a title bar is or how much room the traffic lights
 * need - which is the point. Switching styles changes those variables and
 * this resizes with them.
 *
 * Where the platform reserved no room (`insetLeft === 0`) it drew no buttons
 * either - Windows and Linux lose them with the bar - so this draws working
 * minimise, maximise and close controls in the platform's own shape. A bar
 * without them is only a picture of one: on an undecorated window there is
 * nothing else to close it with.
 */

type Platform = "mac" | "win" | "adw";

/** Which controls to draw, from the synchronous bridge info. */
function platform(): Platform {
  const name = os.infoSync()?.platform;
  if (name === "macos") return "mac";
  if (name === "windows") return "win";
  // Linux and anything else: GNOME-style circles on the trailing edge.
  return "adw";
}

/** Caption glyphs, drawn rather than font-dependent - see `Glyph` in the
 * react example for why a path beats an icon font here. */
const GLYPHS = {
  minimise: "M0 5 H10",
  maximise: "M0.5 0.5 h9 v9 h-9 z",
  restore: "M0.5 2.5 h7 v7 h-7 z M2.5 2.5 v-2 h7 v7 h-2",
  close: "M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5",
} as const;

function glyph(d: string): string {
  return `<svg viewBox="0 0 10 10" aria-hidden="true"><path d="${d}"/></svg>`;
}

/** Whether the window is currently maximised. Kept in step below, because
 * this button is not the only thing that maximises a window: a double-click
 * on the bar does, so does a snap to the edge of the screen. */
let maximized = false;
let zoomButton: HTMLButtonElement | null = null;

export function mountTitleBar(): void {
  const bar = document.getElementById("titlebar");
  if (!bar) return;

  bar.innerHTML =
    '<span class="tb-controls" id="tb-leading"></span>' +
    '<span class="tb-buttons"><button type="button" title="Back">&#8592;</button>' +
    '<button type="button" title="Forward">&#8594;</button></span>' +
    '<span class="tb-search">Vantail Showcase</span>' +
    '<span class="tb-controls" id="tb-trailing"></span>';

  // Nothing wires up dragging. The runtime moves the window from the band a
  // hidden title bar left behind and skips the controls in it, so this bar
  // drags without a listener - and so does a page that draws no bar at all.
  // `appWindow.startDragging()` is still there for a region of your own
  // choosing; see the window panel.

  // Grey the controls on a background window, the way every platform does.
  appWindow.onFocusChanged((state) => {
    bar.classList.toggle("unfocused", !state.focused);
  });

  // A snap or a double-click maximises without going through the button.
  const sync = () => {
    void appWindow.isMaximized().then((next) => {
      if (next !== maximized) {
        maximized = next;
        paintZoom();
      }
    });
  };
  sync();
  appWindow.onResized(sync);

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
  const own = hidden && (metrics?.insetLeft ?? 0) === 0;
  document.documentElement.dataset.ownControls = own ? "yes" : "no";

  paintControls(own);
}

/** Draw working window controls, or clear them when the platform has its own. */
function paintControls(own: boolean): void {
  const leading = document.getElementById("tb-leading");
  const trailing = document.getElementById("tb-trailing");
  zoomButton = null;
  if (leading) {
    leading.innerHTML = "";
    leading.className = "tb-controls";
  }
  if (trailing) {
    trailing.innerHTML = "";
    trailing.className = "tb-controls";
  }
  if (!own) return;

  const pf = platform();
  // macOS keeps its buttons on the leading edge; Windows and GNOME put
  // theirs on the trailing one, after whatever the app has up there.
  const slot = pf === "mac" ? leading : trailing;
  if (!slot) return;
  slot.classList.add(pf);
  slot.innerHTML = controlsHTML(pf);

  for (const button of slot.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
    const action = button.dataset.action;
    button.addEventListener("click", () => {
      if (action === "minimise") void appWindow.minimize();
      else if (action === "zoom") void appWindow.toggleMaximize();
      else if (action === "close") void appWindow.close();
    });
    if (action === "zoom") zoomButton = button;
  }
  paintZoom();
}

function controlsHTML(pf: Platform): string {
  if (pf === "mac") {
    return (
      '<button type="button" class="dot close" title="Close" aria-label="Close" data-action="close"></button>' +
      '<button type="button" class="dot minimise" title="Minimise" aria-label="Minimise" data-action="minimise"></button>' +
      '<button type="button" class="dot zoom" title="Maximise" aria-label="Maximise" data-action="zoom"></button>'
    );
  }
  return (
    '<button type="button" class="cap minimise" title="Minimise" aria-label="Minimise" data-action="minimise">' +
    glyph(GLYPHS.minimise) +
    "</button>" +
    '<button type="button" class="cap zoom" title="Maximise" aria-label="Maximise" data-action="zoom">' +
    glyph(GLYPHS.maximise) +
    "</button>" +
    '<button type="button" class="cap close" title="Close" aria-label="Close" data-action="close">' +
    glyph(GLYPHS.close) +
    "</button>"
  );
}

/** Swap the maximise glyph for a restore one while maximised. */
function paintZoom(): void {
  if (!zoomButton) return;
  const label = maximized ? "Restore" : "Maximise";
  zoomButton.title = label;
  zoomButton.setAttribute("aria-label", label);
  if (platform() !== "mac") {
    zoomButton.innerHTML = glyph(maximized ? GLYPHS.restore : GLYPHS.maximise);
  }
}
