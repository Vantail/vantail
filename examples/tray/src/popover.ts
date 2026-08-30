/**
 * Putting the window under the tray icon.
 *
 * A menu bar application's window is not really a window: it has no
 * decorations, it is not in the taskbar, it sits above everything, and it
 * appears wherever the icon happens to be. All of that is config - see
 * `vantail.config.ts` - except the last part, which has to be worked out each
 * time the icon is clicked, because the icon moves as other applications add
 * and remove their own.
 *
 * ## The units do not match
 *
 * `tray.onClick` reports where the icon is in **physical** pixels.
 * `appWindow.setPosition` takes **logical** ones. On a Retina display that is
 * a factor of two, so passing the click straight through puts the popover off
 * the bottom-right of the screen - and it looks correct on any machine that
 * happens not to be Retina, which is the worst way for a bug like this to
 * behave.
 *
 * `screen.list()` is what closes the gap: it reports each display's logical
 * geometry alongside its `scaleFactor`.
 */

import { appWindow, screen, type Screen } from "@vantail/api";

/** Matches the window size in `vantail.config.ts`. */
export const SIZE = { width: 260, height: 320 };

/** Clear of the menu bar, and clear of the screen edges. */
const GAP = 6;
const MARGIN = 8;

const contains = (display: Screen, x: number, y: number) =>
  x >= display.position.x &&
  x < display.position.x + display.size.width &&
  y >= display.position.y &&
  y < display.position.y + display.size.height;

/**
 * Physical desktop coordinates to logical ones.
 *
 * Which display the point is on is what decides the scale, and the only way
 * to tell is to try: divide by each display's scale factor and see whose
 * logical bounds the result lands in. On the usual setup - one display, or
 * several at the same scale - the first match is the right one.
 */
function toLogical(x: number, y: number, displays: Screen[]) {
  for (const display of displays) {
    const point = { x: x / display.scaleFactor, y: y / display.scaleFactor };
    if (contains(display, point.x, point.y)) return { ...point, display };
  }

  const fallback = displays.find((it) => it.primary) ?? displays[0];
  const scale = fallback?.scaleFactor ?? 1;
  return { x: x / scale, y: y / scale, display: fallback };
}

/** Keep the whole popover on the display it opened on. */
function clamp(x: number, y: number, display: Screen | undefined) {
  if (!display) return { x, y };

  const { position, size } = display;
  return {
    x: Math.min(
      Math.max(x, position.x + MARGIN),
      position.x + size.width - SIZE.width - MARGIN,
    ),
    y: Math.min(
      Math.max(y, position.y + MARGIN),
      position.y + size.height - SIZE.height - MARGIN,
    ),
  };
}

/**
 * Open, close, and the small amount of bookkeeping between them.
 *
 * Clicking the icon while the popover is open produces two things in an order
 * nobody controls: the webview loses focus, and `tray.click` arrives. Handled
 * naively they fight - the blur hides the popover, and the click then sees a
 * hidden window and opens it straight back up, so the icon appears not to
 * close it. The other order is worse: the click opens the popover and the
 * blur immediately shuts it, so the icon appears not to open it at all.
 *
 * Two guards settle it, and both are about time rather than order:
 *
 *   - a blur in the first moments after opening is the tail of the click that
 *     opened it, not the user going elsewhere, so it is ignored;
 *   - a click arriving just after a blur closed the popover *is* that same
 *     gesture, so it closes rather than reopening.
 *
 * `visible` is tracked here rather than asked for with `isVisible()`, because
 * that is a round trip and the answer can change while it is in flight.
 */

let visible = false;
let openedAt = 0;
let closedByBlurAt = 0;

/** Long enough to cover the blur that trails the opening click. */
const SETTLE = 250;
/**
 * How recently a blur-close still counts as part of the click that follows.
 *
 * The blur lands on the press and the click on the release, so this only has
 * to cover how long a click is held. Too long and it swallows a deliberate
 * reopen just after clicking away; this is the one number worth tuning if the
 * icon ever feels unresponsive.
 */
const SAME_GESTURE = 400;

/** Open the popover under the icon that was clicked. */
export async function openAt(physicalX: number, physicalY: number) {
  // Never let a display query keep the window shut: somewhere sensible beats
  // nowhere at all.
  const displays = await screen.list().catch(() => [] as Screen[]);
  const { x, y, display } = toLogical(physicalX, physicalY, displays);

  // Centred on the icon and hanging below it, which is where a menu would be.
  const placed = clamp(x - SIZE.width / 2, y + GAP, display);

  await appWindow.setPosition(placed.x, placed.y);
  await appWindow.show();
  await appWindow.focus();

  visible = true;
  openedAt = Date.now();
}

export async function close() {
  visible = false;
  await appWindow.hide();
}

export async function toggle(physicalX: number, physicalY: number) {
  if (visible || Date.now() - closedByBlurAt < SAME_GESTURE) return close();
  return openAt(physicalX, physicalY);
}

/**
 * Close when the user clicks away, the way a menu does.
 *
 * There is no window-level blur event in the API, but the document gets one
 * when the webview loses focus, and for a window that is only ever shown by
 * the tray that amounts to the same thing.
 */
export function closeOnBlur() {
  window.addEventListener("blur", () => {
    if (!visible) return;
    if (Date.now() - openedAt < SETTLE) return;

    closedByBlurAt = Date.now();
    void close();
  });
}
