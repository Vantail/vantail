import { appWindow, type Platform } from "@vantail/api";

/**
 * Close, minimise and maximise, in the shape the platform draws them.
 *
 * Three platforms, three conventions, and they do not travel. Traffic lights
 * on Windows read as a web page wearing a window, and Windows' square caption
 * buttons on macOS read the same way - a custom title bar is only convincing
 * for as long as its controls are the ones the user already knows, so this
 * branches on the platform rather than picking one look and calling it
 * consistency.
 *
 * What differs is more than the drawing: macOS puts them on the leading edge
 * in close-minimise-zoom order, Windows and GNOME on the trailing edge in
 * minimise-maximise-close. The order lives here; the geometry is in
 * `style.css`, keyed off `data-platform` on the bar.
 */
export function WindowControls({
  platform,
  maximized,
}: {
  platform: Platform;
  maximized: boolean;
}) {
  const restore = maximized ? "Restore" : "Maximise";

  if (platform === "macos") {
    return (
      <span className="titlebar-controls mac">
        <button
          type="button"
          className="dot close"
          title="Close"
          aria-label="Close"
          onClick={() => void appWindow.close()}
        />
        <button
          type="button"
          className="dot minimise"
          title="Minimise"
          aria-label="Minimise"
          onClick={() => void appWindow.minimize()}
        />
        <button
          type="button"
          className="dot zoom"
          title={restore}
          aria-label={restore}
          onClick={() => void appWindow.toggleMaximize()}
        />
      </span>
    );
  }

  return (
    <span
      className={`titlebar-controls ${platform === "windows" ? "win" : "adw"}`}
    >
      <button
        type="button"
        className="cap minimise"
        title="Minimise"
        aria-label="Minimise"
        onClick={() => void appWindow.minimize()}
      >
        <Glyph d="M0 5 H10" />
      </button>
      <button
        type="button"
        className="cap zoom"
        title={restore}
        aria-label={restore}
        onClick={() => void appWindow.toggleMaximize()}
      >
        {maximized ? (
          // The window in front and the one behind it, which is what both
          // platforms draw once there is something to restore to.
          <Glyph d="M0.5 2.5 h7 v7 h-7 z M2.5 2.5 v-2 h7 v7 h-2" />
        ) : (
          <Glyph d="M0.5 0.5 h9 v9 h-9 z" />
        )}
      </button>
      <button
        type="button"
        className="cap close"
        title="Close"
        aria-label="Close"
        onClick={() => void appWindow.close()}
      >
        <Glyph d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" />
      </button>
    </span>
  );
}

/**
 * One caption glyph.
 *
 * Drawn rather than set in Segoe Fluent Icons. That font is the real source
 * of these shapes, but it only exists on Windows 11 - Windows 10 has the same
 * glyphs under a different name, and Linux has neither - and a missing icon
 * font shows as three empty boxes in the corner of every window. A path is
 * the same picture with nothing to install and nothing to fall back to.
 *
 * The box is ten units and the glyph is drawn at ten pixels, so a unit is a
 * pixel and a stroke of 1 is the hairline the system draws - which is what
 * keeps these from looking soft next to a real Windows caption.
 */
function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}
