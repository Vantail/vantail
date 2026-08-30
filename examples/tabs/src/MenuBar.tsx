import { useState } from "react";

import { menu, type MenuItem } from "@vantail/api";

/**
 * The application menu, drawn by the application.
 *
 * Only the bar is HTML. Clicking a title opens the *platform's* menu at that
 * point, through `menu.popup()` - which matters for more than looks: the
 * predefined items in it are the system's own, so Undo and Paste do what they
 * do everywhere else, and a popup is a real window rather than a div that
 * stops at the edge of this one.
 *
 * Where it goes is the caller's business. Inside the title bar is what
 * Explorer and VS Code do on Windows; a row of its own underneath is what
 * every application did before that, and both are one prop apart in
 * `App.tsx`.
 */
export function MenuBar({
  items,
  className,
}: {
  items: MenuItem[];
  className?: string;
}) {
  // Which title has a menu under it. The popup is modal, so this is set
  // before it opens and cleared when it closes - which is what keeps the
  // title highlighted for exactly as long as its menu is up.
  const [open, setOpen] = useState<string | null>(null);

  // A menu bar shows submenus; a bare item at the top level has nothing to
  // drop down and is left to the platform, which is the only place it can
  // mean anything.
  const submenus = items.filter(
    (item): item is Extract<MenuItem, { type: "submenu" }> =>
      item.type === "submenu",
  );

  if (submenus.length === 0) return null;

  const show = async (label: string, entries: MenuItem[], at: HTMLElement) => {
    // Under the title, aligned to its leading edge, the way a menu bar drops.
    // `getBoundingClientRect` is in the same coordinates `popup` wants: the
    // webview fills the window, so the viewport and the window agree.
    const box = at.getBoundingClientRect();
    setOpen(label);
    try {
      await menu.popup(entries, { x: box.left, y: box.bottom });
    } finally {
      setOpen(null);
    }
  };

  return (
    <nav
      className={className ? `menubar ${className}` : "menubar"}
      aria-label="Application"
    >
      {submenus.map((submenu) => (
        <button
          key={submenu.label}
          type="button"
          className={open === submenu.label ? "menubar-item open" : "menubar-item"}
          onClick={(event) =>
            void show(submenu.label, submenu.items, event.currentTarget)
          }
        >
          {submenu.label}
        </button>
      ))}
    </nav>
  );
}
