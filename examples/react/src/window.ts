/**
 * The window's own floor, shared with `vantail.config.ts`.
 *
 * A starting point rather than the last word: `TitleBar.tsx` measures what its
 * own contents actually need and raises the minimum width to that, because a
 * number written here by hand goes stale the moment anything is added to the
 * bar. This is the floor for a window whose title bar is the platform's, and
 * the floor the measured one is never allowed below.
 */
export const MIN_WIDTH = 560;
export const MIN_HEIGHT = 420;
