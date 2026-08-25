import { app } from "@vantail/api";
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
