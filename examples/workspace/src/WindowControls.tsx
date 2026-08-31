/**
 * Minimise, maximise and close, in the shape Windows and most Linux desktops
 * draw them: thin glyphs in tall square hit areas on the trailing edge, with
 * close turning red rather than grey.
 *
 * Rendered only where `insetLeft` is zero - see `titlebar.ts`. On macOS the
 * platform's own buttons are still in the corner and this draws nothing.
 */

import { appWindow } from "@vantail/api";

import { Dismiss, Maximise, Minimise } from "./icons.js";

export function WindowControls({ maximized }: { maximized: boolean }) {
  return (
    <div className="caption">
      <button
        type="button"
        title="Minimise"
        aria-label="Minimise"
        onClick={() => void appWindow.minimize()}
      >
        <Minimise />
      </button>
      <button
        type="button"
        title={maximized ? "Restore" : "Maximise"}
        aria-label={maximized ? "Restore" : "Maximise"}
        onClick={() => void appWindow.toggleMaximize()}
      >
        <Maximise restored={maximized} />
      </button>
      <button
        type="button"
        className="close"
        title="Close"
        aria-label="Close"
        onClick={() => void appWindow.close()}
      >
        <Dismiss />
      </button>
    </div>
  );
}
