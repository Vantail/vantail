/**
 * Shared rendering: IconNode -> SVG string. Used by the vanilla API
 * (`index.ts`) and the React adapter (`react.tsx`) so both draw identically.
 */

import { icons } from "./icons.js";
import type { IconNode, IconOptions } from "./types.js";

export const DEFAULT_SIZE = 24;
export const DEFAULT_STROKE_WIDTH = 2;
export const DEFAULT_COLOR = "currentColor";

/** Placeholder drawn for unknown names — never throws during render. */
const UNKNOWN_NODE: IconNode = [
  ["circle", { cx: "12", cy: "12", r: "9" }],
  ["path", { d: "M12 8v4" }],
  ["path", { d: "M12 16h.01" }],
];

const warned = new Set<string>();

export function normalizeSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SIZE;
}

export function normalizeStrokeWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_STROKE_WIDTH;
}

export function normalizeColor(value: unknown): string {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : DEFAULT_COLOR;
}

/** Escape `&<>"'` for safe interpolation into SVG attributes and text. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function renderChildren(node: IconNode): string {
  let out = "";
  for (const [tag, attrs] of node) {
    out += `<${tag}`;
    for (const [key, attr] of Object.entries(attrs)) {
      if (attr === undefined) continue;
      out += ` ${key}="${escapeHtml(String(attr))}"`;
    }
    out += "/>";
  }
  return out;
}

export interface ResolvedIcon {
  node: IconNode;
  known: boolean;
  /** The name as given (trimmed), for `data-icon` diagnostics. */
  key: string;
}

export function resolveIcon(name: string): ResolvedIcon {
  const key = name.trim();
  const node = (icons as Record<string, IconNode | undefined>)[key];
  if (node) return { node, known: true, key };
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(
      `[@vantail/icons] Unknown icon "${key}". Rendering a placeholder.`,
    );
  }
  return { node: UNKNOWN_NODE, known: false, key };
}

export interface SvgParts extends IconOptions {
  /** Extra SVG attributes (e.g. `class`, `data-*`, `aria-*`). Values are escaped. */
  extraAttrs?: Readonly<Record<string, string | number | boolean | undefined>>;
}

/**
 * Render an icon to an SVG string. Pure function — no DOM needed, so it
 * works in tests, SSR, and the webview alike. Never throws for unknown
 * names; unknown names render the placeholder with `data-unknown="true"`.
 */
export function getIconSvg(name: string, options: SvgParts = {}): string {
  const { node, known, key } = resolveIcon(name);
  const size = normalizeSize(options.size);
  const strokeWidth = normalizeStrokeWidth(options.strokeWidth);
  const color = normalizeColor(options.color);
  const label = typeof options.label === "string" ? options.label.trim() : "";
  const classes = ["vantail-icon"];
  if (typeof options.className === "string" && options.className.trim() !== "") {
    classes.push(options.className.trim());
  }

  let attrs =
    `xmlns="http://www.w3.org/2000/svg"` +
    ` width="${size}" height="${size}" viewBox="0 0 24 24"` +
    ` fill="none" stroke="${escapeHtml(color)}" stroke-width="${strokeWidth}"` +
    ` stroke-linecap="round" stroke-linejoin="round"` +
    ` class="${escapeHtml(classes.join(" "))}"` +
    ` data-icon="${escapeHtml(key)}"`;

  if (!known) attrs += ` data-unknown="true"`;
  if (label !== "") {
    attrs += ` role="img" aria-label="${escapeHtml(label)}"`;
  } else {
    attrs += ` aria-hidden="true"`;
  }
  if (options.extraAttrs) {
    for (const [attrKey, attrValue] of Object.entries(options.extraAttrs)) {
      if (attrValue === undefined) continue;
      if (typeof attrValue === "boolean") {
        if (attrValue) attrs += ` ${attrKey}=""`;
        continue;
      }
      attrs += ` ${attrKey}="${escapeHtml(String(attrValue))}"`;
    }
  }
  return `<svg ${attrs}>${renderChildren(node)}</svg>`;
}

/** For tests: reset the once-per-name unknown-icon warning cache. */
export function resetUnknownIconWarnings(): void {
  warned.clear();
}
