/**
 * The Workspace and Vantail Corp menus in the command bar.
 *
 * Drawn by the page rather than opened as a platform menu: they sit inside
 * the bar and have to line up with it, and a platform popup would be placed
 * by the platform. `menu.popup` is the right tool when the menu is the
 * platform's kind - a context menu on a right click - and the wrong one here.
 */

import { useEffect, useRef, useState } from "react";

import { Chevron } from "./icons.js";

export function Dropdown({
  label,
  items,
  strong,
}: {
  label: string;
  items: string[];
  strong?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState(label);
  const box = useRef<HTMLDivElement>(null);

  // Closing on an outside click is the part that is easy to get wrong: the
  // listener has to be on the document, and it has to ignore clicks inside
  // this menu - including on the button that opened it, which would otherwise
  // close and reopen in the same gesture.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={box}>
      <button
        type="button"
        className={`bar-button${strong ? " strong" : ""}${open ? " open" : ""}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((it) => !it)}
      >
        {chosen}
        <Chevron />
      </button>

      {open && (
        <div className="menu" role="menu">
          {items.map((item) => (
            <button
              type="button"
              role="menuitem"
              key={item}
              className={item === chosen ? "on" : undefined}
              onClick={() => {
                setChosen(item);
                setOpen(false);
              }}
            >
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
