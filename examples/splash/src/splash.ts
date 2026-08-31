/**
 * The splash screen, and the handover to the application.
 *
 * The window it runs in is the one the config opens, so it is on screen as
 * early as anything can be. It has no frame and no buttons - `decorations:
 * false` - and its own corner shape, which is what `borderRadius` is for.
 *
 * Nothing here drags the window. A window with no title bar leaves no band for
 * the runtime to move it by, so a splash stays where it was put.
 */

import { appWindow, createWindow } from "@vantail/api";

/** How long the imaginary work takes. */
const DURATION = 5000;

const STEPS = [
  [0, "Starting"],
  [0.2, "Reading settings"],
  [0.45, "Opening the database"],
  [0.7, "Loading your workspace"],
  [0.92, "Almost there"],
] as const;

const fill = document.getElementById("fill")!;
const step = document.getElementById("step")!;
const bar = fill.parentElement!;

/**
 * Driven from a wall-clock deadline rather than by adding a slice per frame.
 * A progress bar that counts frames finishes late on a busy machine, and the
 * whole point of this window is that it is on screen while the machine is
 * busy.
 */
const started = performance.now();

function tick() {
  const elapsed = performance.now() - started;
  const progress = Math.min(1, elapsed / DURATION);

  fill.style.width = `${progress * 100}%`;
  bar.setAttribute("aria-valuenow", String(Math.round(progress * 100)));

  const reached = STEPS.filter(([at]) => progress >= at).at(-1);
  if (reached) step.textContent = reached[1];

  if (progress < 1) {
    requestAnimationFrame(tick);
    return;
  }

  void handOver();
}

requestAnimationFrame(tick);

/**
 * Open the application, then close this.
 *
 * In that order, and it matters: closing the last window quits, so a splash
 * that shuts before the application exists takes the process with it.
 * `createWindow` resolves once the new window's page is running, so by the
 * time this returns there is something to hand over to.
 */
async function handOver() {
  step.textContent = "Ready";

  await createWindow("app", {
    url: "app.html",
    title: "Splash Example",
    width: 860,
    height: 560,
    center: true,
  });

  await appWindow.close();
}
