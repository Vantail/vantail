import {
  appWindow,
  createWindow,
  currentWindow,
  getWindow,
  listWindows,
  onWindowClosed,
  onWindowCreated,
  onWindowReady,
  windowLabel,
} from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/** This window, and any others the application opens. */
export function windowPanel(): Panel {
  const p = panel("window", "window", "Size, position, state, and more than one of them.");

  p.row(
    p.button("size()", () => appWindow.size()),
    p.button("position()", () => appWindow.position()),
    p.button("isMaximized()", () => appWindow.isMaximized()),
    p.button("isVisible()", () => appWindow.isVisible()),
  );

  p.row(
    p.button("center()", () => appWindow.center()),
    p.button("toggleMaximize()", () => appWindow.toggleMaximize()),
    p.button("setFullscreen(true)", () => appWindow.setFullscreen(true)),
    p.button("setFullscreen(false)", () => appWindow.setFullscreen(false)),
  );

  const title = p.input("title", "Vantail Showcase");
  p.row(title, p.button("setTitle()", () => appWindow.setTitle(title.value)));

  p.row(
    p.button("alwaysOnTop on", () => appWindow.setAlwaysOnTop(true)),
    p.button("alwaysOnTop off", () => appWindow.setAlwaysOnTop(false)),
    p.button("openDevtools()", () => appWindow.openDevtools()),
  );

  // Hiding rather than destroying is what a tray application wants: the
  // window comes back with its state intact instead of reloading.
  p.row(
    p.button("closeBehavior()", () => appWindow.closeBehavior()),
    p.button("close -> hide", () => appWindow.setCloseBehavior("hide")),
    p.button("close -> close", () => appWindow.setCloseBehavior("close")),
    p.button("close -> ask", () => appWindow.setCloseBehavior("ask")),
  );
  p.note("With `hide`, the close button leaves the window alive. Bring it back from the tray panel.");

  const label = p.input("label", "second");
  p.row(
    label,
    p.button("createWindow()", async () => {
      const child = await createWindow(label.value, {
        title: `Showcase: ${label.value}`,
        width: 520,
        height: 380,
      });
      return `opened ${child.label}`;
    }),
    p.button("focus it", () => getWindow(label.value).focus()),
    p.button("close it", () => getWindow(label.value).close()),
  );

  p.row(
    p.button("listWindows()", () => listWindows()),
    p.button("currentWindow()", () => currentWindow() ?? "(unlabelled)"),
    // The synchronous form: available before the first await, which is what
    // a page needs when it must know which window it is while starting up.
    p.button("windowLabel()", () => windowLabel() ?? "(unlabelled)"),
  );

  appWindow.onResized((size) => p.log(`resized to ${size.width}x${size.height}`));
  appWindow.onMoved((at) => p.log(`moved to ${at.x},${at.y}`));
  appWindow.onFocusChanged((state) => p.log(state.focused ? "focused" : "blurred"));
  onWindowCreated((event) => p.log(`window created: ${event.label}`));
  // `created` fires when the window exists; `ready` when its page has loaded
  // and can be sent messages.
  onWindowReady((event) => p.log(`window ready: ${event.label}`));
  onWindowClosed((event) => p.log(`window closed: ${event.label}`));

  return p;
}
