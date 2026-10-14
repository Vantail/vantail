/**
 * Pure application logic for Vantail Symbols.
 *
 * This module deliberately imports nothing: no DOM, no `@vantail/icons`, no
 * storage globals. Everything it needs (the name list, the known-name check,
 * the storage object) is passed in, so it runs unchanged in the application
 * and under `node --test` (see `test/symbols.test.js`).
 */

export const FAVORITES_KEY = "vantail-symbols:favorites";
export const RECENT_KEY = "vantail-symbols:recent";

/** Recently-viewed history is bounded; favorites are not. */
export const RECENT_MAX = 24;

/** Grid cells are painted in chunks so the full catalogue never renders at once. */
export const GRID_PAGE = 240;

export const DEFAULT_SIZE = 24;
export const DEFAULT_STROKE_WIDTH = 2;
export const DEFAULT_COLOR = "currentColor";

export const MIN_SIZE = 16;
export const MAX_SIZE = 96;
export const MIN_STROKE_WIDTH = 0.5;
export const MAX_STROKE_WIDTH = 3;

export interface PreviewOptions {
  size: number;
  strokeWidth: number;
  color: string;
}

export const DEFAULT_PREVIEW: PreviewOptions = {
  size: 48,
  strokeWidth: DEFAULT_STROKE_WIDTH,
  color: DEFAULT_COLOR,
};

/** Minimal storage surface; `localStorage` satisfies it, tests inject fakes. */
export interface NameStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Case-insensitive substring matching over canonical kebab-case names. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function filterIconNames(
  names: readonly string[],
  query: string,
): string[] {
  const needle = normalizeQuery(query);
  if (needle === "") return [...names];
  return names.filter((name) => name.toLowerCase().includes(needle));
}

export function clampSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PREVIEW.size;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(value)));
}

export function clampStrokeWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_STROKE_WIDTH;
  }
  // Quarter steps keep the slider honest: 1.75 renders, 1.73 would be a lie.
  const stepped = Math.round(value * 4) / 4;
  return Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, stepped));
}

export function normalizePreviewColor(value: unknown): string {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : DEFAULT_COLOR;
}

/** Escape a value for interpolation into generated TypeScript/TSX source. */
function escapeSnippetString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** `size`/`strokeWidth`/`color` props, omitting whatever is still the default. */
export function snippetProps(options: PreviewOptions): string[] {
  const props: string[] = [];
  if (options.size !== DEFAULT_SIZE) props.push(`size={${options.size}}`);
  if (options.strokeWidth !== DEFAULT_STROKE_WIDTH) {
    props.push(`strokeWidth={${options.strokeWidth}}`);
  }
  if (options.color !== DEFAULT_COLOR) {
    props.push(`color="${escapeSnippetString(options.color)}"`);
  }
  return props;
}

/** Options form of the same props, for the vanilla `getIconSvg` snippet. */
function snippetOptionsObject(options: PreviewOptions): string {
  const entries: string[] = [];
  if (options.size !== DEFAULT_SIZE) entries.push(`size: ${options.size}`);
  if (options.strokeWidth !== DEFAULT_STROKE_WIDTH) {
    entries.push(`strokeWidth: ${options.strokeWidth}`);
  }
  if (options.color !== DEFAULT_COLOR) {
    entries.push(`color: "${escapeSnippetString(options.color)}"`);
  }
  return entries.length === 0 ? "" : `, { ${entries.join(", ")} }`;
}

/**
 * Copyable vanilla usage for an icon, using only the documented
 * `getIconSvg(name, options)` API.
 */
export function vanillaSnippet(name: string, options: PreviewOptions): string {
  const safe = escapeSnippetString(name);
  return (
    `import { getIconSvg } from "@vantail/icons";\n` +
    `\n` +
    `document.body.innerHTML = getIconSvg("${safe}"${snippetOptionsObject(options)});`
  );
}

/**
 * Copyable React usage for an icon, using only the documented dynamic
 * `<Icon name>` API (full catalogue, no per-icon imports to get wrong).
 */
export function reactSnippet(name: string, options: PreviewOptions): string {
  const safe = escapeSnippetString(name);
  const props = snippetProps(options);
  const attrs = props.length === 0 ? "" : " " + props.join(" ");
  return (
    `import { Icon } from "@vantail/icons/react";\n` +
    `\n` +
    `<Icon name="${safe}"${attrs} />`
  );
}

/** Toggle membership, preserving order; new favorites append at the end. */
export function toggleFavorite(
  favorites: readonly string[],
  name: string,
): { names: string[]; added: boolean } {
  if (favorites.includes(name)) {
    return { names: favorites.filter((entry) => entry !== name), added: false };
  }
  return { names: [...favorites, name], added: true };
}

/**
 * Most-recent-first history with duplicates removed and a bounded length.
 * Unknown names are ignored so a Lucide upgrade that renames an icon cannot
 * poison the stored history.
 */
export function pushRecent(
  recent: readonly string[],
  name: string,
  isKnown: (name: string) => boolean,
  max: number = RECENT_MAX,
): string[] {
  if (!isKnown(name)) return [...recent];
  return [name, ...recent.filter((entry) => entry !== name)].slice(0, max);
}

/** Parse stored JSON, dropping anything that is not a known icon name. */
export function sanitizeNameList(
  value: unknown,
  isKnown: (name: string) => boolean,
): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || seen.has(entry) || !isKnown(entry)) continue;
    seen.add(entry);
    names.push(entry);
  }
  return names;
}

export function loadNameList(
  storage: NameStorage | null | undefined,
  key: string,
  isKnown: (name: string) => boolean,
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (raw === null) return [];
    return sanitizeNameList(JSON.parse(raw), isKnown);
  } catch {
    // Corrupt or unavailable storage is an empty list, never a crash.
    return [];
  }
}

export function saveNameList(
  storage: NameStorage | null | undefined,
  key: string,
  names: readonly string[],
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(names));
    return true;
  } catch {
    return false;
  }
}
