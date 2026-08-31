/**
 * Light or dark, and the colour the window is painted before either exists.
 *
 * shadcn's `dark:` variant keys off a `.dark` class rather than the media
 * query, because a class is the only version an application can override. This
 * puts it on and keeps it in step with the system.
 */

/**
 * The two `--background` values from `src/index.css`, as hex.
 *
 * A duplicate, and a deliberate one: `createWindow` needs this colour before
 * there is a document to read a computed style off - the whole point of
 * `backgroundColor` is that it is on screen while the page does not yet exist.
 * Anything derived from CSS would arrive a paint too late to be the thing that
 * shows first.
 */
export const BACKGROUND = { light: "#ffffff", dark: "#0a0a0a" } as const;

const query = () => matchMedia("(prefers-color-scheme: dark)");

/** Which of the two the system is asking for, right now. */
export const prefersDark = () => query().matches;

/**
 * Follow the system for as long as this window is open.
 *
 * Applied before React mounts, so the first frame is already the right colour
 * rather than a white one that turns dark.
 *
 * The window's own `backgroundColor` was fixed when it was created and does not
 * follow: change the system theme with a window open and a live resize will
 * briefly show the old colour down the side. Repainting it would mean the
 * runtime letting a window change its background after the fact, which it does
 * not, and a stale strip during a drag that only happens if you switch themes
 * mid-session is a fair price for not having one.
 */
export function followSystemTheme(): () => void {
  const media = query();

  const apply = () => {
    document.documentElement.classList.toggle("dark", media.matches);
    // Scrollbars, focus rings and any form control the platform draws are
    // outside the reach of the class, and take this instead.
    document.documentElement.style.colorScheme = media.matches ? "dark" : "light";
  };

  apply();
  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
}
