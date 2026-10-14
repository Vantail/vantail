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
 * Canonical icon names shipped in this release.
 *
 * A curated, tree-shakeable subset of Lucide — every name is a real Lucide
 * name, so anything learned in Lucide's docs transfers. The full Lucide
 * catalogue is intentionally not bundled: a name-based `Icon` over all of
 * Lucide would put every icon in every app.
 */
export type IconName =
  | "archive"
  | "arrow-left"
  | "arrow-right"
  | "bell"
  | "bookmark"
  | "calendar"
  | "camera"
  | "check"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "circle-check"
  | "circle-x"
  | "clock"
  | "copy"
  | "download"
  | "external-link"
  | "eye"
  | "eye-off"
  | "file-text"
  | "folder"
  | "folder-open"
  | "globe"
  | "heart"
  | "house"
  | "image"
  | "inbox"
  | "info"
  | "loader-circle"
  | "lock"
  | "log-out"
  | "mail"
  | "menu"
  | "message-square"
  | "mic"
  | "pause"
  | "pencil"
  | "phone"
  | "play"
  | "plus"
  | "refresh-cw"
  | "save"
  | "search"
  | "send"
  | "settings"
  | "share-2"
  | "sliders-horizontal"
  | "star"
  | "triangle-alert"
  | "upload"
  | "user"
  | "users"
  | "video"
  | "volume-2"
  | "wifi"
  | "x"
  | "zap";

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
