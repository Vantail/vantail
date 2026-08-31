import { useState } from "react";

import { menu, type MenuItem } from "@vantail/api";

/**
 * The application menu, drawn by the application.
 *
 * One button, and the whole menu hangs off it: File, Edit, View, Playback and
 * Help arrive as a vertical list, each opening its own items to the side. That
 * is what Spotify does on Windows, and what a media player wants - a row of
 * titles across the top is a lot of chrome to spend on a menu nobody opens
 * twice a session.
 *
 * Only the button is HTML. Everything below it is the *platform's* menu, opened
 * through `menu.popup()` - which matters for more than looks: the predefined
 * items in it are the system's own, so Undo and Paste do what they do
 * everywhere else, submenus open the way the platform opens them, and a popup
 * is a real window rather than a div that stops at the edge of this one.
 *
 * macOS never sees this. There the menu bar is the system's, at the top of the
 * screen, and a hidden title bar does not touch it - see `platform.ts`.
 */
export function MenuBar({
  items,
  className,
}: {
  items: MenuItem[];
  className?: string;
}) {
  // The popup is modal, so this is set before it opens and cleared when it
  // closes - which keeps the button lit for exactly as long as the menu is up.
  const [open, setOpen] = useState(false);

  if (items.length === 0) return null;

  const show = async (at: HTMLElement) => {
    // Under the button and aligned to its leading edge, the way a menu drops.
    // `getBoundingClientRect` is in the coordinates `popup` wants: the webview
    // fills the window, so the viewport and the window agree.
    const box = at.getBoundingClientRect();
    setOpen(true);
    try {
      await menu.popup(items, { x: box.left, y: box.bottom });
    } finally {
      setOpen(false);
    }
  };

  return (
    <nav
      className={className ? `menubar ${className}` : "menubar"}
      aria-label="Application"
    >
      <button
        type="button"
        className={open ? "menubar-button open" : "menubar-button"}
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => void show(event.currentTarget)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
        </svg>
      </button>
    </nav>
  );
}
