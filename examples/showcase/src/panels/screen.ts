import { screen } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/** The displays, in logical pixels. */
export function screenPanel(): Panel {
  const p = panel("screen", "screen", "The monitors attached, and which one this window is on.");

  p.row(
    p.button("list()", () => screen.list()),
    p.button("primary()", () => screen.primary()),
    p.button("current()", () => screen.current()),
  );

  const x = p.input("x", "0");
  const y = p.input("y", "0");
  p.row(x, y, p.button("fromPoint()", () => screen.fromPoint(Number(x.value), Number(y.value))));

  p.note(
    "Sizes and positions are logical pixels, the same units appWindow uses, so a " +
      "window can be placed from a screen's bounds without touching scale factors.",
  );

  return p;
}
