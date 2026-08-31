/**
 * Nothing.
 *
 * This file used to wire `pointerdown` to `appWindow.startDragging()` and
 * `dblclick` to `toggleMaximize`, because a window with a hidden title bar has
 * nothing left to drag it by and `-webkit-app-region: drag` is a Chromium
 * extension that a `WKWebView` does not implement.
 *
 * The runtime does that itself now: the band a hidden bar left behind moves
 * the window, and controls inside it are left alone. So this application ships
 * no JavaScript at all - which is the point it was trying to make.
 */

export {};
