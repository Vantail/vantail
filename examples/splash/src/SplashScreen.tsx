/**
 * The splash screen, and the handover to the application.
 *
 * The window this runs in is the one the config opens, so it is on screen as
 * early as anything can be. It has no frame and no buttons - `decorations:
 * false` - and its own corner shape, which is what `borderRadius` is for.
 *
 * Nothing drags this window, and nothing had to be written to stop it: the
 * drag band the runtime uses is the one a hidden title bar leaves behind, and
 * a window with no title bar at all leaves none.
 */

import { useEffect, useState } from "react";

import { appWindow, createWindow } from "@vantail/api";

import { Progress } from "@/components/ui/progress";
import { BACKGROUND, prefersDark } from "@/theme";
import { BAR_HEIGHT, MIN_HEIGHT, MIN_WIDTH } from "@/window";

/** How long the imaginary work takes. */
const DURATION = 5000;

const STEPS = [
  [0, "Starting"],
  [0.2, "Reading settings"],
  [0.45, "Opening the database"],
  [0.7, "Loading your workspace"],
  [0.92, "Almost there"],
] as const;

export function SplashScreen() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    /*
     * Driven from a wall-clock deadline rather than by adding a slice per
     * frame. A progress bar that counts frames finishes late on a busy
     * machine, and the whole point of this window is that it is on screen
     * while the machine is busy.
     */
    const started = performance.now();
    let frame = 0;
    let handed = false;

    const tick = () => {
      const done = Math.min(1, (performance.now() - started) / DURATION);
      setProgress(done);

      if (done < 1) {
        frame = requestAnimationFrame(tick);
        return;
      }

      // Guarded because React runs effects twice in development's strict
      // mode, and handing over twice means asking for a window label that is
      // already taken - which rejects, and leaves the splash on screen.
      if (handed) return;
      handed = true;
      void handOver();
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const step = progress >= 1 ? "Ready" : (STEPS.filter(([at]) => progress >= at).at(-1)?.[1] ?? "");

  return (
    // No `border-radius` here. The window's corners come from `borderRadius`
    // in `vantail.config.ts` and the runtime clips the page to them, so the
    // orange simply runs to the edge.
    <div className="bg-brand text-brand-foreground grid h-full place-items-center">
      <main className="w-full px-8">
        <p className="text-2xl font-bold tracking-tight">Vantail</p>
        <p className="mt-0.5 mb-6 text-sm text-white/75">Getting things ready</p>

        {/*
          shadcn's Progress, which is Radix's - so the ARIA is already right and
          the value only has to be a number. The component is stock; everything
          it needs bending for this window is done from here, through the
          arbitrary variants below, so it stays a file the registry can update.

          Two bends. The colours, because the component's defaults come from a
          palette that assumes a page background rather than a window painted
          in one flat colour.

          And `transition-none`, which matters more than it looks. The stock
          indicator carries `transition-all`, so a change of value eases into
          place - right for a bar that ticks over a few times, wrong for one
          driven every animation frame. Each frame restarts the 150ms
          transition from where the last one had got to, and a transition that
          is never allowed to finish gets nowhere: the inline style reads 73%
          while the bar on screen is still sitting at 1%. Driving it per frame
          means owning the animation, so the easing has to go.
        */}
        <Progress
          value={progress * 100}
          className="h-1.5 bg-black/20 [&>[data-slot=progress-indicator]]:bg-white [&>[data-slot=progress-indicator]]:transition-none"
        />

        <p className="mt-3 text-xs text-white/70 tabular-nums">{step}</p>
      </main>
    </div>
  );
}

/**
 * Open the application, then close this.
 *
 * In that order, and it matters: closing the last window quits, so a splash
 * that shuts before the application exists takes the process with it.
 * `createWindow` resolves once the new window's page is running, so by the
 * time this returns there is something to hand over to.
 *
 * A window made at runtime starts from the defaults rather than from `window`
 * in the config, so everything the application window needs is asked for here
 * - including the hidden title bar it draws its own in place of. That is the
 * whole reason those three options are in this call and not in
 * `vantail.config.ts`: the config describes the splash.
 */
async function handOver() {
  const dark = prefersDark();

  await createWindow("app", {
    url: "app.html",
    title: "Splash Example",
    width: 900,
    height: 620,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    center: true,

    // No platform title bar; the page runs to the top edge of the window and
    // `TitleBar.tsx` draws what goes there. On macOS the traffic lights stay,
    // and `titleBarHeight` is what re-centres them in a bar this tall instead
    // of leaving them up where a 28pt one would have put them.
    titleBarStyle: "hidden",
    titleBarHeight: BAR_HEIGHT,

    // What shows before the page has painted, and under the strip a live
    // resize opens up while the web view catches up. Matched to the theme the
    // window is about to draw itself in, or a dark application flashes white
    // down one side every time it is dragged wider.
    backgroundColor: dark ? BACKGROUND.dark : BACKGROUND.light,
  });

  await appWindow.close();
}
