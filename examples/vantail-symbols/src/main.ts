/**
 * Vantail Symbols — a Lucide icon browser for Vantail developers.
 *
 * Vanilla DOM over `@vantail/icons` (the single source of truth for the
 * catalogue) and `@vantail/api` for clipboard access. No framework, no
 * state library, no network: icons are SVG strings bundled at build time.
 */

import "./style.css";

import { clipboard, isVantail } from "@vantail/api";
import { getIconSvg, iconNames, isIconName } from "@vantail/icons";

import {
  clampSize,
  clampStrokeWidth,
  DEFAULT_PREVIEW,
  FAVORITES_KEY,
  filterIconNames,
  GRID_PAGE,
  loadNameList,
  MAX_SIZE,
  MAX_STROKE_WIDTH,
  MIN_SIZE,
  MIN_STROKE_WIDTH,
  normalizePreviewColor,
  pushRecent,
  reactSnippet,
  RECENT_KEY,
  saveNameList,
  toggleFavorite,
  vanillaSnippet,
  type PreviewOptions,
} from "./lib.js";

type View = "all" | "favorites" | "recent";
type PreviewTheme = "system" | "light" | "dark";

const VIEWS: { id: View; title: string }[] = [
  { id: "all", title: "All Icons" },
  { id: "favorites", title: "Favorites" },
  { id: "recent", title: "Recently Viewed" },
];

const PREVIEW_SIZES = [16, 24, 32, 48];

const COLOR_PRESETS: { value: string; label: string }[] = [
  { value: "currentColor", label: "Automatic" },
  { value: "#1c1f26", label: "Ink" },
  { value: "#ffffff", label: "White" },
  { value: "#c2263f", label: "Red" },
  { value: "#e8822a", label: "Orange" },
  { value: "#2f5fd0", label: "Blue" },
  { value: "#2f9e6e", label: "Green" },
  { value: "#6d4fc2", label: "Purple" },
];

const known = (name: string): boolean => isIconName(name);

const storage: Storage | null = (() => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
})();

interface State {
  view: View;
  query: string;
  shown: number;
  selected: string | null;
  preview: PreviewOptions;
  previewTheme: PreviewTheme;
  favorites: string[];
  recent: string[];
}

const state: State = {
  view: "all",
  query: "",
  shown: GRID_PAGE,
  selected: isIconName("house") ? "house" : (iconNames[0] ?? null),
  preview: { ...DEFAULT_PREVIEW },
  previewTheme: "system",
  favorites: loadNameList(storage, FAVORITES_KEY, known),
  recent: loadNameList(storage, RECENT_KEY, known),
};

// ---------------------------------------------------------------------------
// DOM shells (static structure from index.html)
// ---------------------------------------------------------------------------

const brandMark = document.querySelector<HTMLElement>("#brand-mark")!;
const search = document.querySelector<HTMLInputElement>("#search")!;
const searchClear = document.querySelector<HTMLButtonElement>("#search-clear")!;
const count = document.querySelector<HTMLElement>("#count")!;
const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const viewTitle = document.querySelector<HTMLElement>("#view-title")!;
const clearRecent = document.querySelector<HTMLButtonElement>("#clear-recent")!;
const grid = document.querySelector<HTMLElement>("#grid")!;
const gridEnd = document.querySelector<HTMLElement>("#grid-end")!;
const empty = document.querySelector<HTMLElement>("#empty")!;
const inspector = document.querySelector<HTMLElement>("#inspector")!;
const status = document.querySelector<HTMLElement>("#status")!;

brandMark.innerHTML = getIconSvg(isIconName("shapes") ? "shapes" : "house", {
  size: 20,
  label: "",
});

let statusTimer: number | undefined;

function setStatus(message: string, failed = false): void {
  status.hidden = false;
  status.textContent = message;
  status.classList.toggle("failed", failed);
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    status.hidden = true;
  }, failed ? 5000 : 2200);
}

/**
 * Copy text through the supported Vantail clipboard API, falling back to the
 * web clipboard when running outside the runtime (e.g. `vite dev` in a
 * browser). Failures are reported, never silently swallowed.
 */
async function copyText(text: string): Promise<void> {
  if (isVantail()) {
    await clipboard.writeText(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy path: the async clipboard can exist yet
      // refuse (permissions policy, headless, non-secure context).
    }
  }
  legacyCopy(text);
}

/** Synchronous clipboard fallback for contexts without the async API. */
function legacyCopy(text: string): void {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("the browser refused clipboard access");
    }
  } finally {
    area.remove();
  }
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await copyText(text);
    setStatus(`Copied ${what} to the clipboard.`);
  } catch (cause) {
    setStatus(
      `Copy failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// Catalogue views
// ---------------------------------------------------------------------------

function baseNames(): string[] {
  switch (state.view) {
    case "favorites": {
      const wanted = new Set(state.favorites);
      return iconNames.filter((name) => wanted.has(name));
    }
    case "recent":
      return state.recent.filter(known);
    case "all":
    default:
      return [...iconNames];
  }
}

function visibleNames(): string[] {
  return filterIconNames(baseNames(), state.query);
}

function formatCount(total: number, shown: number): string {
  const fmt = (n: number): string => n.toLocaleString("en-US");
  return shown < total
    ? `${fmt(shown)} of ${fmt(total)} icons`
    : `${fmt(total)} ${total === 1 ? "icon" : "icons"}`;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

const sidebarButtons = new Map<View, HTMLButtonElement>();

function buildSidebar(): void {
  for (const view of VIEWS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "side-item";
    button.setAttribute("aria-label", view.title);
    button.addEventListener("click", () => {
      if (state.view !== view.id) {
        state.view = view.id;
        state.shown = GRID_PAGE;
        renderAll();
        grid.focus({ preventScroll: true });
      }
    });
    sidebar.append(button);
    sidebarButtons.set(view.id, button);
  }
  const hint = document.createElement("p");
  hint.className = "side-hint";
  hint.textContent = `${iconNames.length.toLocaleString("en-US")} Lucide icons, bundled offline.`;
  sidebar.append(hint);
}

function renderSidebar(): void {
  const counts: Record<View, number> = {
    all: iconNames.length,
    favorites: state.favorites.length,
    recent: state.recent.length,
  };
  for (const view of VIEWS) {
    const button = sidebarButtons.get(view.id)!;
    button.classList.toggle("active", state.view === view.id);
    button.setAttribute("aria-current", state.view === view.id ? "page" : "false");
    button.innerHTML = "";
    const label = document.createElement("span");
    label.textContent = view.title;
    const badge = document.createElement("span");
    badge.className = "side-count";
    badge.textContent = counts[view.id].toLocaleString("en-US");
    button.append(label, badge);
  }
  viewTitle.textContent = VIEWS.find((view) => view.id === state.view)!.title;
  clearRecent.hidden = state.view !== "recent" || state.recent.length === 0;
}

// ---------------------------------------------------------------------------
// Icon grid (paged so the catalogue never renders all at once)
// ---------------------------------------------------------------------------

function cellHtml(name: string): string {
  const selected = name === state.selected;
  const favorite = state.favorites.includes(name);
  return (
    `<button type="button" role="option" class="cell${selected ? " selected" : ""}"` +
    ` data-name="${name}" aria-selected="${selected}"` +
    ` aria-label="${name}${favorite ? ", favorite" : ""}">` +
    `<span class="cell-art" aria-hidden="true">${getIconSvg(name, { size: 26 })}</span>` +
    `<span class="cell-name">${name}</span>` +
    (favorite ? `<span class="cell-star" aria-hidden="true">★</span>` : "") +
    `</button>`
  );
}

function renderGrid(): void {
  const names = visibleNames();
  const page = names.slice(0, state.shown);
  grid.innerHTML = page.map(cellHtml).join("");
  gridEnd.hidden = state.shown >= names.length;

  const hasResults = names.length > 0;
  empty.hidden = hasResults;
  grid.style.display = hasResults ? "" : "none";
  gridEnd.style.display = hasResults ? "" : "none";
  if (!hasResults) {
    if (state.query.trim() !== "") {
      empty.textContent = `No icons match “${state.query.trim()}”. Try a shorter fragment, e.g. “arrow” or “heart”.`;
    } else if (state.view === "favorites") {
      empty.textContent =
        "No favorites yet. Select an icon and press “Favorite” to pin it here.";
    } else {
      empty.textContent = "Nothing here yet. Icons you view will appear in this list.";
    }
  }
  count.textContent = hasResults
    ? formatCount(names.length, Math.min(state.shown, names.length))
    : "0 icons";
  searchClear.hidden = search.value === "";
}

const pager = new IntersectionObserver(
  (entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    if (state.shown < visibleNames().length) {
      state.shown += GRID_PAGE;
      renderGrid();
    }
  },
  { root: null, rootMargin: "600px" },
);
pager.observe(gridEnd);

grid.addEventListener("click", (event) => {
  const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-name]");
  if (cell?.dataset.name) select(cell.dataset.name, { recordRecent: true });
});

function gridCells(): HTMLButtonElement[] {
  return [...grid.querySelectorAll<HTMLButtonElement>("[data-name]")];
}

/** How many cells share the first row — the stride for Up/Down navigation. */
function gridColumns(): number {
  const cells = gridCells();
  if (cells.length === 0) return 1;
  const top = cells[0]!.offsetTop;
  let columns = 0;
  for (const cell of cells) {
    if (cell.offsetTop !== top) break;
    columns += 1;
  }
  return Math.max(1, columns);
}

grid.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "ArrowUp" && event.key !== "ArrowDown") {
    return;
  }
  const cells = gridCells();
  if (cells.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  let index = cells.findIndex((cell) => cell === active || cell.contains(active));
  if (index === -1) {
    index = Math.max(0, cells.findIndex((cell) => cell.dataset.name === state.selected));
  }
  const stride = event.key === "ArrowUp" || event.key === "ArrowDown" ? gridColumns() : 1;
  const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? stride : -stride;
  const next = Math.min(cells.length - 1, Math.max(0, index + delta));
  event.preventDefault();
  cells[next]!.focus();
});

// ---------------------------------------------------------------------------
// Selection, favorites, recents
// ---------------------------------------------------------------------------

function select(name: string, options: { recordRecent: boolean }): void {
  if (!known(name)) return;
  state.selected = name;
  if (options.recordRecent) {
    const next = pushRecent(state.recent, name, known);
    if (next.join() !== state.recent.join()) {
      state.recent = next;
      saveNameList(storage, RECENT_KEY, state.recent);
    }
  }
  // The grid page is cheap to repaint; the inspector repaints on its own.
  for (const cell of gridCells()) {
    const active = cell.dataset.name === name;
    cell.classList.toggle("selected", active);
    cell.setAttribute("aria-selected", String(active));
  }
  renderSidebar();
  renderInspector();
  if (state.view === "recent" && options.recordRecent) renderGrid();
}

function toggleSelectedFavorite(): void {
  if (!state.selected) return;
  const { names, added } = toggleFavorite(state.favorites, state.selected);
  state.favorites = names;
  saveNameList(storage, FAVORITES_KEY, state.favorites);
  setStatus(added ? `Added “${state.selected}” to favorites.` : `Removed “${state.selected}” from favorites.`);
  renderSidebar();
  renderGrid();
  renderInspector();
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

let previewArt: HTMLElement;
let previewBox: HTMLElement;
let inspectorName: HTMLElement;
let favButton: HTMLButtonElement;
let sizeInput: HTMLInputElement;
let sizeValue: HTMLElement;
let strokeInput: HTMLInputElement;
let strokeValue: HTMLElement;
let colorRow: HTMLElement;
let customColor: HTMLInputElement;
let themeRow: HTMLElement;
let copyButtons: HTMLButtonElement[] = [];

/** The preview settings as snippet options, shared by both copy actions. */
function currentOptions(): PreviewOptions {
  return {
    size: state.preview.size,
    strokeWidth: state.preview.strokeWidth,
    color: state.preview.color,
  };
}

function labeledSlider(
  id: string,
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
): { wrap: HTMLElement; input: HTMLInputElement; output: HTMLElement } {
  const wrap = document.createElement("div");
  wrap.className = "control";
  const lab = document.createElement("label");
  lab.htmlFor = id;
  lab.textContent = label;
  const input = document.createElement("input");
  input.id = id;
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const output = document.createElement("span");
  output.className = "control-value";
  wrap.append(lab, input, output);
  return { wrap, input, output };
}

/**
 * A copy action that generates its snippet at click time, so it always
 * reflects the current preview settings. No code preview is kept in the DOM:
 * the inspector stays compact and there is nothing stale to read.
 */
function copyAction(label: string, build: (name: string) => string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-label", `Copy ${label} code`);
  button.addEventListener("click", () => {
    if (state.selected) void copy(build(state.selected), `${label} snippet`);
  });
  copyButtons.push(button);
  return button;
}

function buildInspector(): void {
  inspector.innerHTML = "";
  copyButtons = [];

  const heading = document.createElement("h2");
  heading.className = "visually-hidden";
  heading.textContent = "Icon inspector";
  inspector.append(heading);

  previewBox = document.createElement("div");
  previewBox.id = "preview-box";
  previewBox.className = "preview-system";
  previewArt = document.createElement("div");
  previewArt.className = "preview-art";
  previewBox.append(previewArt);
  inspector.append(previewBox);

  const nameRow = document.createElement("div");
  nameRow.className = "name-row";
  inspectorName = document.createElement("p");
  inspectorName.className = "inspector-name";
  const copyName = document.createElement("button");
  copyName.type = "button";
  copyName.textContent = "Copy name";
  copyName.setAttribute("aria-label", "Copy canonical icon name");
  copyName.addEventListener("click", () => {
    if (state.selected) void copy(state.selected, "icon name");
  });
  favButton = document.createElement("button");
  favButton.type = "button";
  favButton.className = "fav-button";
  favButton.addEventListener("click", toggleSelectedFavorite);
  nameRow.append(inspectorName, copyName, favButton);
  inspector.append(nameRow);

  const sizes = document.createElement("div");
  sizes.className = "size-strip";
  sizes.setAttribute("aria-label", "Icon at fixed sizes");
  inspector.append(sizes);
  (buildInspector as { sizeStrip?: HTMLElement }).sizeStrip = sizes;

  const size = labeledSlider("preview-size", "Size", MIN_SIZE, MAX_SIZE, 1, state.preview.size);
  sizeInput = size.input;
  sizeValue = size.output;
  sizeInput.addEventListener("input", () => {
    state.preview.size = clampSize(Number(sizeInput.value));
    renderInspector();
  });
  inspector.append(size.wrap);

  const stroke = labeledSlider("preview-stroke", "Stroke width", MIN_STROKE_WIDTH, MAX_STROKE_WIDTH, 0.25, state.preview.strokeWidth);
  strokeInput = stroke.input;
  strokeValue = stroke.output;
  strokeInput.addEventListener("input", () => {
    state.preview.strokeWidth = clampStrokeWidth(Number(strokeInput.value));
    renderInspector();
  });
  inspector.append(stroke.wrap);

  const colorWrap = document.createElement("div");
  colorWrap.className = "control";
  const colorLabel = document.createElement("span");
  colorLabel.className = "control-label";
  colorLabel.id = "color-label";
  colorLabel.textContent = "Color";
  colorRow = document.createElement("div");
  colorRow.className = "swatches";
  colorRow.setAttribute("role", "group");
  colorRow.setAttribute("aria-labelledby", "color-label");
  for (const preset of COLOR_PRESETS) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "swatch";
    swatch.title = preset.label;
    swatch.setAttribute("aria-label", `Color ${preset.label}`);
    swatch.dataset.color = preset.value;
    swatch.style.setProperty("--swatch", preset.value === "currentColor" ? "transparent" : preset.value);
    if (preset.value === "currentColor") swatch.classList.add("auto");
    swatch.textContent = preset.value === "currentColor" ? "A" : "";
    swatch.addEventListener("click", () => {
      state.preview.color = preset.value;
      renderInspector();
    });
    colorRow.append(swatch);
  }
  customColor = document.createElement("input");
  customColor.type = "color";
  customColor.className = "swatch custom";
  customColor.title = "Custom color";
  customColor.setAttribute("aria-label", "Custom color");
  customColor.addEventListener("input", () => {
    state.preview.color = normalizePreviewColor(customColor.value);
    renderInspector();
  });
  colorRow.append(customColor);
  colorWrap.append(colorLabel, colorRow);
  inspector.append(colorWrap);

  const themeWrap = document.createElement("div");
  themeWrap.className = "control";
  const themeLabel = document.createElement("span");
  themeLabel.className = "control-label";
  themeLabel.textContent = "Preview background";
  themeRow = document.createElement("div");
  themeRow.className = "segmented";
  themeRow.setAttribute("role", "group");
  themeRow.setAttribute("aria-label", "Preview background");
  for (const theme of ["system", "light", "dark"] as PreviewTheme[]) {
    const option = document.createElement("button");
    option.type = "button";
    option.dataset.theme = theme;
    option.textContent = theme[0]!.toUpperCase() + theme.slice(1);
    option.setAttribute("aria-pressed", String(state.previewTheme === theme));
    option.addEventListener("click", () => {
      state.previewTheme = theme;
      renderInspector();
    });
    themeRow.append(option);
  }
  themeWrap.append(themeLabel, themeRow);
  inspector.append(themeWrap);

  const copyRow = document.createElement("div");
  copyRow.className = "copy-row";
  copyRow.setAttribute("role", "group");
  copyRow.setAttribute("aria-label", "Copy icon code");
  copyRow.append(
    copyAction("Vanilla", (name) => vanillaSnippet(name, currentOptions())),
    copyAction("React", (name) => reactSnippet(name, currentOptions())),
  );
  inspector.append(copyRow);
}

function renderInspector(): void {
  const name = state.selected;
  const strip = (buildInspector as { sizeStrip?: HTMLElement }).sizeStrip;
  if (!name || !known(name)) {
    previewArt.innerHTML = `<span class="preview-none">No icon selected</span>`;
    inspectorName.textContent = "—";
    favButton.textContent = "☆ Favorite";
    favButton.setAttribute("aria-pressed", "false");
    favButton.disabled = true;
    for (const button of copyButtons) button.disabled = true;
    if (strip) strip.innerHTML = "";
    return;
  }
  favButton.disabled = false;
  for (const button of copyButtons) button.disabled = false;

  previewBox.classList.remove("preview-system", "preview-light", "preview-dark");
  previewBox.classList.add(`preview-${state.previewTheme}`);
  previewArt.innerHTML = getIconSvg(name, {
    size: state.preview.size,
    strokeWidth: state.preview.strokeWidth,
    color: state.preview.color,
    label: `${name} icon preview`,
  });

  inspectorName.textContent = name;

  const favorited = state.favorites.includes(name);
  favButton.textContent = favorited ? "★ Favorited" : "☆ Favorite";
  favButton.setAttribute("aria-pressed", String(favorited));
  favButton.setAttribute(
    "aria-label",
    favorited ? `Remove ${name} from favorites` : `Add ${name} to favorites`,
  );

  if (strip) {
    strip.innerHTML = PREVIEW_SIZES.map(
      (size) =>
        `<span class="size-cell" title="${size}px">${getIconSvg(name, {
          size,
          strokeWidth: state.preview.strokeWidth,
          color: state.preview.color,
        })}<small>${size}</small></span>`,
    ).join("");
  }

  sizeInput.value = String(state.preview.size);
  sizeValue.textContent = `${state.preview.size}px`;
  strokeInput.value = String(state.preview.strokeWidth);
  strokeValue.textContent = `${state.preview.strokeWidth}px`;

  for (const swatch of colorRow.querySelectorAll<HTMLButtonElement>(".swatch[data-color]")) {
    const active = swatch.dataset.color === state.preview.color;
    swatch.classList.toggle("active", active);
    swatch.setAttribute("aria-pressed", String(active));
  }
  if (!COLOR_PRESETS.some((preset) => preset.value === state.preview.color)) {
    customColor.value = /^#[0-9a-fA-F]{6}$/.test(state.preview.color)
      ? state.preview.color
      : "#000000";
  }

  for (const option of themeRow.querySelectorAll<HTMLButtonElement>("[data-theme]")) {
    const active = option.dataset.theme === state.previewTheme;
    option.classList.toggle("active", active);
    option.setAttribute("aria-pressed", String(active));
  }
}

// ---------------------------------------------------------------------------
// Search, shortcuts, wiring
// ---------------------------------------------------------------------------

function renderAll(): void {
  renderSidebar();
  renderGrid();
  renderInspector();
}

search.addEventListener("input", () => {
  state.query = search.value;
  state.shown = GRID_PAGE;
  renderSidebar();
  renderGrid();
});

search.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    search.value = "";
    state.query = "";
    state.shown = GRID_PAGE;
    renderGrid();
    search.blur();
  }
  if (event.key === "Enter") {
    const first = gridCells()[0];
    if (first?.dataset.name) {
      select(first.dataset.name, { recordRecent: true });
      first.focus();
    }
  }
});

searchClear.addEventListener("click", () => {
  search.value = "";
  state.query = "";
  state.shown = GRID_PAGE;
  renderGrid();
  search.focus();
});

clearRecent.addEventListener("click", () => {
  state.recent = [];
  saveNameList(storage, RECENT_KEY, state.recent);
  state.shown = GRID_PAGE;
  renderAll();
});

document.addEventListener("keydown", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const typing = target?.closest("input, textarea, [contenteditable]");
  if (event.key === "/" && !typing) {
    event.preventDefault();
    search.focus();
  } else if ((event.key === "f" || event.key === "F") && !typing && state.selected) {
    event.preventDefault();
    toggleSelectedFavorite();
  } else if (event.key === "Escape" && target instanceof HTMLElement) {
    target.blur();
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

buildSidebar();
buildInspector();
renderAll();
