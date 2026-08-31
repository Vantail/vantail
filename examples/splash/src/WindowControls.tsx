/**
 * Close, minimise and maximise, in the shape the platform draws them.
 *
 * Three platforms, three conventions, and they do not travel: traffic lights
 * on Windows read as a web page wearing a window, and Windows' square caption
 * buttons on macOS read the same way. A custom title bar is only convincing
 * for as long as its controls are the ones the user already knows, so this
 * branches on the platform rather than picking one look and calling it
 * consistency.
 *
 * What differs is more than the drawing: macOS puts them on the leading edge
 * in close-minimise-zoom order, Windows and GNOME on the trailing edge in
 * minimise-maximise-close. The order lives here, the placement in `TitleBar`.
 *
 * These are the one part of this example not built out of shadcn's `Button`.
 * They are the system's affordance rather than the application's, and a
 * caption button that picks up an accent colour, a focus ring and a rounded
 * corner from the design system is the tell of a bar that is only a picture of
 * one.
 */

import { useEffect, useState, type ReactNode } from "react";

import { appWindow } from "@vantail/api";

import { PLATFORM } from "@/platform";

export function WindowControls({ focused }: { focused: boolean }) {
  // Windows and GNOME swap the maximise button for a restore one, so the bar
  // has to know which the window currently is. Asked again on every resize,
  // because this button is not the only thing that maximises a window: a
  // double click on the bar does, and so does a snap to the edge of the
  // screen. A button still offering to maximise a maximised window is another
  // of those tells.
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const sync = () => void appWindow.isMaximized().then(setMaximized);
    sync();
    return appWindow.onResized(sync);
  }, []);

  const restore = maximized ? "Restore" : "Maximise";

  if (PLATFORM === "macos") {
    return (
      <div className="flex items-center gap-2 pl-3 pr-4">
        <Dot
          label="Close"
          colour="bg-[#ff5f57]"
          focused={focused}
          onClick={() => void appWindow.close()}
        />
        <Dot
          label="Minimise"
          colour="bg-[#febc2e]"
          focused={focused}
          onClick={() => void appWindow.minimize()}
        />
        <Dot
          label={restore}
          colour="bg-[#28c840]"
          focused={focused}
          onClick={() => void appWindow.toggleMaximize()}
        />
      </div>
    );
  }

  if (PLATFORM === "windows") {
    return (
      // Full height and hard into the corner. Windows leaves no margin around
      // these: the close button's hit area runs to the last pixel of the
      // window so that throwing the pointer at the corner closes it, and a
      // button with a gap around it misses that by a few pixels every time.
      <div className={`flex items-stretch self-stretch ${focused ? "" : "text-muted-foreground"}`}>
        <Caption label="Minimise" onClick={() => void appWindow.minimize()}>
          <Glyph d="M0 5 H10" />
        </Caption>
        <Caption label={restore} onClick={() => void appWindow.toggleMaximize()}>
          {maximized ? (
            // The window in front and the one behind it, which is what both
            // platforms draw once there is something to restore to.
            <Glyph d="M0.5 2.5 h7 v7 h-7 z M2.5 2.5 v-2 h7 v7 h-2" />
          ) : (
            <Glyph d="M0.5 0.5 h9 v9 h-9 z" />
          )}
        </Caption>
        <Caption
          label="Close"
          className="hover:bg-[#c42b1c] hover:text-white active:bg-[#c84031] active:text-white"
          onClick={() => void appWindow.close()}
        >
          <Glyph d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" />
        </Caption>
      </div>
    );
  }

  // GNOME: round grey buttons, the same order as Windows. Adwaita draws them
  // at 24 points whatever the header bar is, sitting on a filled circle rather
  // than on the bar itself.
  return (
    <div className="flex items-center gap-2 pl-1.5 pr-1.5">
      <Adwaita label="Minimise" onClick={() => void appWindow.minimize()}>
        <Glyph d="M0 5 H10" round />
      </Adwaita>
      <Adwaita label={restore} onClick={() => void appWindow.toggleMaximize()}>
        {maximized ? (
          <Glyph d="M0.5 2.5 h7 v7 h-7 z M2.5 2.5 v-2 h7 v7 h-2" round />
        ) : (
          <Glyph d="M0.5 0.5 h9 v9 h-9 z" round />
        )}
      </Adwaita>
      <Adwaita label="Close" onClick={() => void appWindow.close()}>
        <Glyph d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" round />
      </Adwaita>
    </div>
  );
}

/**
 * One macOS traffic light.
 *
 * Grey while the window is not in front, which is what macOS does and what
 * tells you at a glance which window is listening to the keyboard. Coloured
 * dots on a background window are the tell this component exists to avoid.
 */
function Dot({
  label,
  colour,
  focused,
  onClick,
}: {
  label: string;
  colour: string;
  focused: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`size-3 rounded-full ${focused ? colour : "bg-border"}`}
    />
  );
}

/** One Windows caption button: 46 points wide at every title bar height. */
function Caption({
  label,
  className = "",
  onClick,
  children,
}: {
  label: string;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`grid w-[46px] place-items-center hover:bg-foreground/8 active:bg-foreground/5 ${className}`}
    >
      {children}
    </button>
  );
}

/** One Adwaita caption button. */
function Adwaita({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-full bg-foreground/10 hover:bg-foreground/16 active:bg-foreground/24"
    >
      {children}
    </button>
  );
}

/**
 * One caption glyph.
 *
 * Drawn rather than set in Segoe Fluent Icons. That font is the real source of
 * these shapes, but it only exists on Windows 11 - Windows 10 has the same
 * glyphs under a different name, and Linux has neither - and a missing icon
 * font shows as three empty boxes in the corner of every window. A path is the
 * same picture with nothing to install and nothing to fall back to.
 *
 * The box is ten units and the glyph is drawn at ten pixels, so a unit is a
 * pixel and a stroke of 1 is the hairline the system draws, which is what
 * keeps these from looking soft next to a real Windows caption. GNOME's
 * symbolic icons are heavier and rounded, hence `round`.
 */
function Glyph({ d, round = false }: { d: string; round?: boolean }) {
  return (
    <svg
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
      className={round ? "size-[9px]" : "size-[10px]"}
      fill="none"
      stroke="currentColor"
      strokeWidth={round ? 1.6 : 1}
      strokeLinecap={round ? "round" : "butt"}
      strokeLinejoin={round ? "round" : "miter"}
    >
      <path d={d} />
    </svg>
  );
}
