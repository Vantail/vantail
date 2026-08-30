/**
 * The timer, with no Vue in it.
 *
 * Two things need to read this state and they are not both components: the
 * popover renders it, and the tray title writes it into the menu bar every
 * second whether the popover is open or not. Keeping the state here means the
 * one that matters most - the menu bar - does not depend on a window existing.
 */

import { reactive } from "vue";

export type Phase = "focus" | "break";

/** Short enough to sit through while trying the example out. */
export const LENGTH: Record<Phase, number> = {
  focus: 25 * 60,
  break: 5 * 60,
};

export const timer = reactive({
  phase: "focus" as Phase,
  /** Seconds left in the current phase. */
  left: LENGTH.focus,
  running: false,
  /** Completed focus phases, reset by hand rather than by the clock. */
  done: 0,
});

/** `25:00`, and what the menu bar shows. */
export function clock(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

export function start() {
  timer.running = true;
}

export function pause() {
  timer.running = false;
}

export function toggle() {
  timer.running = !timer.running;
}

/** Back to the start of the current phase, still stopped. */
export function reset() {
  timer.running = false;
  timer.left = LENGTH[timer.phase];
}

export function switchTo(phase: Phase) {
  timer.phase = phase;
  timer.left = LENGTH[phase];
  timer.running = false;
}

/**
 * Drive the clock.
 *
 * One loop for the whole application. The popover and the menu bar used to
 * have an interval each, which meant two readings of `timer.left` taken up to
 * a second apart - so the menu bar and the dial disagreed about the time, and
 * a countdown that disagrees with itself is worse than no countdown. `onTick`
 * fires when the *displayed* value changes, and both are painted from it.
 *
 * The remaining time is computed from a wall-clock deadline rather than by
 * subtracting one per tick, because a background webview does not get a
 * reliable 1Hz timer: the system throttles it hard once the popover is shut -
 * measured here at 2 to 4 second gaps - and a phase counted in ticks would
 * finish however late the machine had been busy.
 */
export function run({
  onTick,
  onFinish,
}: {
  onTick: () => void;
  onFinish: (finished: Phase) => void;
}): () => void {
  let endsAt = 0;
  let running = timer.running;
  let shown = "";

  const id = setInterval(() => {
    // Starting: take the deadline from what is left on the clock now.
    if (timer.running && !running) endsAt = Date.now() + timer.left * 1000;
    // Pausing: what is left is whatever had not elapsed.
    if (!timer.running && running) timer.left = Math.max(0, (endsAt - Date.now()) / 1000);
    running = timer.running;

    if (timer.running) timer.left = Math.max(0, (endsAt - Date.now()) / 1000);

    // Only when the second on show has changed. Repainting the menu bar four
    // times a second would be three writes nobody can see.
    const next = clock(timer.left);
    if (next !== shown) {
      shown = next;
      onTick();
    }

    if (!timer.running || timer.left > 0) return;

    const finished = timer.phase;
    timer.done += finished === "focus" ? 1 : 0;
    switchTo(finished === "focus" ? "break" : "focus");
    shown = clock(timer.left);
    onTick();
    onFinish(finished);
  }, 200);

  return () => clearInterval(id);
}
