import { os, type Platform } from "@vantail/api";

/**
 * Which platform this window is on, decided once.
 *
 * Read synchronously off the injected bridge rather than awaited from
 * `os.platform()`: the window controls are in the first frame the title bar
 * paints, so a promise resolving a tick later would draw the wrong ones and
 * then swap them, which you can see happen. Outside a Vantail window - `vite
 * dev` in a browser - there is nothing to ask, so the user agent decides and
 * the interface still previews.
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
