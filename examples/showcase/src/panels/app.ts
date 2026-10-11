import { app, sharedState } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/** Identity, lifecycle, and the app's own event bus. */
export function appPanel(): Panel {
  const p = panel("app", "app", "Who this application is, and its own event bus between windows.");

  p.row(
    p.button("info()", () => app.info()),
    p.button("isDev()", () => app.isDev()),
    // The sync form is filled in before the page runs, so it needs no await.
    p.button("infoSync()", () => app.infoSync()),
  );

  const event = p.input("event name", "showcase/ping");
  const payload = p.input("payload", "hello");
  p.row(
    event,
    payload,
    p.button("emit()", () => app.emit(event.value, payload.value)),
  );

  // Delivered to every window, including this one, which is what makes it
  // useful for keeping a settings window and a main window in step.
  app.listen(event.value || "showcase/ping", (data, meta) => {
    p.log(`heard ${JSON.stringify(data)} from ${meta.from ?? "the runtime"}`);
  });

  p.row(
    p.button("setBadge(3)", () => app.setBadge(3)),
    p.button("clear badge", () => app.setBadge(null)),
  );
  p.note("A badge shows on the dock or taskbar icon, where the platform has one.");

  p.row(
    p.button("restart()", () => app.restart()),
    p.button("quit()", () => app.quit()),
  );

  return p;
}

/** Keyed state every window reads and writes, owned by the runtime. */
export function sharedStatePanel(): Panel {
  const p = panel(
    "sharedState",
    "sharedState",
    "One store for every window: the runtime owns the values, and a write reaches all of them.",
  );

  const key = p.input("key", "showcase.counter");
  const value = p.input("value", "1");
  p.row(
    key,
    p.button("get()", () => sharedState.get(key.value)),
    value,
    p.button("set()", () => sharedState.set(key.value, parse(value.value))),
  );

  // Watching the key this panel named when the button was pressed.
  let stop: (() => void) | undefined;
  p.row(
    p.button("watch", () => {
      stop?.();
      const watched = key.value;
      stop = sharedState.subscribe(watched, (current) =>
        p.log(`${watched} is now ${JSON.stringify(current)}`),
      );
      return `watching ${watched}`;
    }),
    p.button("unwatch", () => {
      stop?.();
      stop = undefined;
      return "stopped watching";
    }),
  );

  p.note(
    "The last write wins, and every window hears - including the one that wrote. " +
      "Open this page in a second window and set a key here to watch it arrive there. " +
      "The config grants `showcase.**`; anything else is SHARED_STATE_KEY_DENIED.",
  );

  return p;
}

/** What the value box means: JSON when it parses, a string otherwise. */
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
