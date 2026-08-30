/**
 * Minimise, maximise and close, for the platforms that took the real ones
 * away with the title bar.
 *
 * On macOS this renders nothing: the traffic lights are still there, and a
 * second set of controls beside them would be worse than useless.
 */

import { appWindow } from "@vantail/api";

export function WindowControls() {
  return (
    <div className="window-controls">
      <button title="Minimise" onClick={() => void appWindow.minimize()}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 6h7" />
        </svg>
      </button>
      <button title="Maximise" onClick={() => void appWindow.toggleMaximize()}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
        </svg>
      </button>
      <button className="close" title="Close" onClick={() => void appWindow.close()}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
    </div>
  );
}
