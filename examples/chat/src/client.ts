/**
 * The only JavaScript this application ships, and all of it is about the
 * window rather than the interface.
 *
 * Dragging and double-click-to-zoom are what a title bar does, and neither is
 * something CSS can offer - `-webkit-app-region: drag` is a Chromium
 * extension that a `WKWebView` does not implement. Everything else on the
 * page, the insets included, is done without any of this.
 */

import { appWindow } from "@vantail/api";

const isControl = (target: EventTarget | null) =>
  (target as Element | null)?.closest("button, input, textarea, a, [role='menu']");

document.addEventListener("pointerdown", (event) => {
  const bar = (event.target as Element | null)?.closest("[data-drag]");
  if (!bar || isControl(event.target) || event.buttons !== 1) return;
  void appWindow.startDragging();
});

document.addEventListener("dblclick", (event) => {
  const bar = (event.target as Element | null)?.closest("[data-drag]");
  if (!bar || isControl(event.target)) return;
  void appWindow.toggleMaximize();
});
