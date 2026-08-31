import { os, type Platform } from "@vantail/api";

/**
 * Which platform this window is on, decided once.
 *
 * Read synchronously off the injected bridge rather than awaited from
 * `os.platform()`: the title bar's controls and menu are in the first frame
 * the window paints, so a promise resolving a tick later would draw the wrong
 * ones and then swap them, which you can see happen. Outside a Vantail window
 * - `vite dev` in a browser - there is nothing to ask, so the user agent
 * decides and the interface still previews.
 */
function detect(): Platform {
  const known = os.infoSync()?.platform;
  if (known) return known;
  const agent = navigator.userAgent;
  if (agent.includes("Windows")) return "windows";
  if (agent.includes("Mac")) return "macos";
  return "linux";
}

export const PLATFORM = detect();

/**
 * Whether the application has to draw the menu itself.
 *
 * macOS has a menu bar of its own that a hidden title bar does not touch, so
 * the platform menu is the menu there. Windows and Linux hang theirs off the
 * window frame, and `titleBarStyle: "hidden"` is an undecorated window - the
 * menu is still installed and its accelerators still fire, but there is no
 * frame left for it to appear in. Drawing it is the only way to see it.
 */
export const DRAWS_OWN_MENU = PLATFORM !== "macos";
