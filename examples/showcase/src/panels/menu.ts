import { menu } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/**
 * The application menu, and context menus.
 *
 * On macOS the predefined items are not decoration: without `copy` and
 * `paste` present, those shortcuts do nothing anywhere in the app, including
 * in text inputs.
 */
export function menuPanel(): Panel {
  const p = panel("menu", "menu", "The application menu bar, and right-click menus.");

  p.row(
    p.button("set() a custom menu", () =>
      menu.set([
        {
          type: "submenu",
          label: "Showcase",
          items: [
            { type: "predefined", item: "about" },
            { type: "separator" },
            { id: "demo-action", label: "An action", accelerator: "CmdOrCtrl+D" },
            { type: "checkbox", id: "demo-toggle", label: "A toggle", checked: true },
            { type: "separator" },
            { type: "predefined", item: "quit" },
          ],
        },
        {
          type: "submenu",
          label: "Edit",
          items: [
            { type: "predefined", item: "cut" },
            { type: "predefined", item: "copy" },
            { type: "predefined", item: "paste" },
            { type: "predefined", item: "selectAll" },
          ],
        },
      ]),
    ),
    p.button("remove()", () => menu.remove()),
  );

  p.row(
    p.button("setLabel()", () => menu.setLabel("demo-action", "Renamed action")),
    p.button("disable it", () => menu.setEnabled("demo-action", false)),
    p.button("enable it", () => menu.setEnabled("demo-action", true)),
    p.button("isChecked()", () => menu.isChecked("demo-toggle")),
  );

  p.row(
    p.button("popup() a context menu", () =>
      menu.popup([
        { id: "ctx-one", label: "First" },
        { id: "ctx-two", label: "Second" },
        { type: "separator" },
        { type: "checkbox", id: "ctx-three", label: "Checkable", checked: false },
      ]),
    ),
  );
  p.note("Set the custom menu first, then use the items: clicks arrive below.");

  // A checkbox reports its new state through `isChecked`, not through the
  // click, so the handler stays the same shape for every kind of item.
  menu.onClick(({ id }) => p.log(`clicked ${id}`));

  return p;
}
