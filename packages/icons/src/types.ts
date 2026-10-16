/**
 * Shared types for `@vantail/icons`.
 *
 * Names are canonical Lucide kebab-case names pinned to the `lucide`
 * dependency in `package.json` (see `icons.ts`). No alternative spellings
 * are accepted: `house` works, `Home` and `HOUSE` do not.
 */

import type { IconNode as LucideIconNode } from "lucide";

/**
 * A single Lucide icon: an array of `[tag, attrs]` pairs.
 * Re-exported from the official `lucide` package so artwork stays in sync.
 */
export type IconNode = LucideIconNode;

/**
 * Canonical icon names: every file-backed icon in the installed `lucide`
 * package. Generated — see `./icons.generated.js` (written by
 * `scripts/generate-icons.mjs`). No alternative spellings are accepted:
 * `house` works, `Home` and `HOUSE` do not.
 */
export type { IconName } from "./icons.generated.js";

/** Presentation options shared by the vanilla and React APIs. */
export interface IconOptions {
  /** Width and height in pixels. Defaults to `24`. Must be finite and > 0. */
  size?: number;
  /** SVG stroke width. Defaults to `2`. Must be finite and >= 0. */
  strokeWidth?: number;
  /** Stroke color. Defaults to `"currentColor"` so icons inherit text color. */
  color?: string;
  /**
   * Accessible label. When present the SVG gets `role="img"` and
   * `aria-label`; when absent the SVG is `aria-hidden="true"` (decorative).
   */
  label?: string;
  /** Extra CSS class appended to the built-in `vantail-icon` class. */
  className?: string;
}
