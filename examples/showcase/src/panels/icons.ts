/**
 * Vantail Icons: the first-party Lucide icon library.
 *
 * Vanilla API against the same nodes React apps get from
 * `@vantail/icons/react`, so both draw identically. Full catalogue —
 * every file-backed Lucide icon — with size, stroke, color, a11y, dynamic
 * lookup, a searchable gallery, and unknown-name handling each on its own row.
 */

import { createIconElement, getIconSvg, iconNames, isIconName } from "@vantail/icons";
import { panel, type Panel } from "../ui.js";

const NAV = ["house", "search", "settings", "bell", "menu", "user"] as const;

function demo(icon: string, options?: { size?: number; strokeWidth?: number; color?: string; label?: string }): HTMLElement {
  const wrap = document.createElement("span");
  wrap.style.display = "inline-flex";
  wrap.style.alignItems = "center";
  wrap.style.justifyContent = "center";
  wrap.style.padding = "6px";
  wrap.title = icon;
  wrap.append(createIconElement(icon, options));
  return wrap;
}

export function iconsPanel(): Panel {
  const p = panel(
    "icons",
    "icons",
    "Lucide icons as a first-party API: name it, size it, color it. Decorative by default, labelled when it means something.",
  );

  // 1. Common navigation icons.
  const nav = document.createElement("div");
  nav.style.display = "flex";
  nav.style.gap = "4px";
  for (const name of NAV) nav.append(demo(name, { size: 22 }));
  p.row(nav);
  p.note("Navigation set: house, search, settings, bell, menu, user — canonical Lucide names.");

  // 2. Sizes.
  const sizes = document.createElement("div");
  sizes.style.display = "flex";
  sizes.style.alignItems = "center";
  sizes.style.gap = "8px";
  for (const size of [16, 20, 24, 32]) {
    const cell = document.createElement("span");
    cell.style.display = "inline-flex";
    cell.style.flexDirection = "column";
    cell.style.alignItems = "center";
    cell.style.gap = "2px";
    cell.append(demo("search", { size }));
    const caption = document.createElement("small");
    caption.textContent = `${size}px`;
    cell.append(caption);
    sizes.append(cell);
  }
  p.row(sizes);

  // 3. Stroke widths.
  const strokes = document.createElement("div");
  strokes.style.display = "flex";
  strokes.style.alignItems = "center";
  strokes.style.gap = "8px";
  for (const strokeWidth of [1, 1.5, 2, 2.5]) {
    const cell = document.createElement("span");
    cell.style.display = "inline-flex";
    cell.style.flexDirection = "column";
    cell.style.alignItems = "center";
    cell.style.gap = "2px";
    cell.append(demo("heart", { size: 26, strokeWidth }));
    const caption = document.createElement("small");
    caption.textContent = `${strokeWidth}px`;
    cell.append(caption);
    strokes.append(cell);
  }
  p.row(strokes);
  p.note("Default is 24px at stroke-width 2, matching Lucide.");

  // 4. Inherited and explicit colors.
  const colors = document.createElement("div");
  colors.style.display = "flex";
  colors.style.alignItems = "center";
  colors.style.gap = "8px";
  const inherited = demo("star", { size: 24 });
  inherited.style.color = "inherit";
  colors.append(inherited);
  for (const [name, color] of [["heart", "crimson"], ["zap", "darkorange"], ["globe", "steelblue"]] as const) {
    const cell = demo(name, { size: 24, color });
    colors.append(cell);
  }
  const themed = document.createElement("span");
  themed.style.color = "mediumseagreen";
  themed.style.display = "inline-flex";
  themed.append(createIconElement("check", { size: 24 }));
  themed.title = "inherits surrounding text color";
  colors.append(themed);
  p.row(colors);
  p.note("No color prop means currentColor: icons inherit the surrounding text color.");

  // 5. Icons alongside text.
  const items = document.createElement("div");
  items.style.display = "flex";
  items.style.flexDirection = "column";
  items.style.gap = "4px";
  for (const [icon, text] of [["folder-open", "Open project…"], ["save", "Save"], ["trash", "Delete"]] as const) {
    const line = document.createElement("span");
    line.style.display = "inline-flex";
    line.style.alignItems = "center";
    line.style.gap = "8px";
    line.append(createIconElement(icon, { size: 18 }));
    line.append(document.createTextNode(text));
    items.append(line);
  }
  p.row(items);

  // 6. Accessible usage: labelled vs decorative, with the actual markup shown.
  p.row(
    p.button("show labelled markup", () => getIconSvg("search", { label: "Search" })),
    p.button("show decorative markup", () => getIconSvg("search")),
  );
  p.note("A label adds role=\"img\" + aria-label; without one the SVG is aria-hidden.");

  // 7. Searchable gallery over the full catalogue (capped so the page stays light).
  const search = p.input("search icons…", "rocket");
  const count = document.createElement("small");
  count.style.alignSelf = "center";
  const grid = document.createElement("div");
  grid.style.display = "flex";
  grid.style.flexWrap = "wrap";
  grid.style.gap = "2px";
  grid.style.maxHeight = "220px";
  grid.style.overflowY = "auto";
  const MAX_SHOWN = 60;
  function renderGallery(): void {
    const query = search.value.trim().toLowerCase();
    const matches =
      query === "" ? [...iconNames] : iconNames.filter((name) => name.includes(query));
    grid.replaceChildren(...matches.slice(0, MAX_SHOWN).map((name) => demo(name, { size: 24 })));
    count.textContent =
      `${matches.length} of ${iconNames.length}` +
      (matches.length > MAX_SHOWN ? ` (first ${MAX_SHOWN} shown)` : "");
  }
  search.addEventListener("input", renderGallery);
  renderGallery();
  p.row(search, count, p.button("isIconName?", () => String(isIconName(search.value.trim()))));
  p.row(grid);
  p.note(
    "Dynamic lookup spans the full catalogue — try rocket, funnel, satellite, a-arrow-down. " +
      "No network, works offline once bundled; the grid caps at 60 so the page stays light.",
  );

  // 8. Unknown icon-name handling.
  const input = p.input("icon name…", "not-an-icon");
  const unknownPreview = document.createElement("span");
  unknownPreview.style.display = "inline-flex";
  p.row(
    input,
    p.button("render name", () => {
      const name = input.value.trim() === "" ? "definitely-not-an-icon" : input.value;
      unknownPreview.replaceChildren(createIconElement(name, { size: 28 }));
      return getIconSvg(name, { size: 28 });
    }),
    unknownPreview,
  );
  p.note("Unknown names never throw: a placeholder with data-unknown renders and warns once in the console.");

  return p;
}
