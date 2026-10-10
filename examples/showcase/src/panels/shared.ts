import { sharedState } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/** A keyed store every window stays in sync with. */
export function sharedStatePanel(): Panel {
  const p = panel(
    "sharedState",
    "sharedState",
    "A keyed store owned by the runtime. Either window writes; every window hears.",
  );

  const key = p.input("key", "demo.counter");
  const value = p.input("value", "1");
  p.row(
    key,
    value,
    p.button("set()", () => sharedState.set(key.value, JSON.parse(value.value))),
    p.button("get()", () => sharedState.get(key.value, null)),
  );

  p.row(
    p.button("subscribe()", () => {
      sharedState.subscribe<unknown>(key.value, (current) =>
        p.log(`${key.value} is now ${JSON.stringify(current)}`),
      );
      return `subscribed to ${key.value}`;
    }),
  );

  p.note(
    "Values must be JSON-serializable. Reads need `sharedState.read`, writes a " +
      "matching `sharedState.write` pattern (`*` stops at a `.`, `**` crosses it). " +
      "Subscribing delivers the current value immediately, then every change.",
  );

  return p;
}
