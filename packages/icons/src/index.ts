/**
 * `@vantail/icons` — vanilla (framework-free) API.
 *
 * Works anywhere DOM or SVG strings work, including the vanilla showcase.
 * React apps should import from `@vantail/icons/react` instead.
 */

import { iconNames, icons, isIconName } from "./icons.js";
import { getIconSvg } from "./shared.js";
import type { IconName, IconNode, IconOptions } from "./types.js";

export { iconNames, icons, isIconName, getIconSvg };
export type { IconName, IconNode, IconOptions };
export { DEFAULT_COLOR, DEFAULT_SIZE, DEFAULT_STROKE_WIDTH } from "./shared.js";

export interface CreateElementOptions extends IconOptions {
  /** Extra SVG attributes. Values are escaped before insertion. */
  extraAttrs?: Readonly<Record<string, string | number | boolean | undefined>>;
}

interface DocumentLike {
  createElement(tag: string): { innerHTML: string };
}

/**
 * Create a real `SVGElement` for an icon.
 *
 * Unknown names render the placeholder (see `getIconSvg`) rather than
 * throwing, so a typo can never blank a whole toolbar.
 *
 * `doc` defaults to the global `document` and only exists as a parameter
 * so tests can inject a stub.
 */
export function createIconElement(
  name: string,
  options: CreateElementOptions = {},
  doc: DocumentLike = globalThis.document,
): SVGElement {
  if (!doc || typeof doc.createElement !== "function") {
    throw new Error(
      "[@vantail/icons] createIconElement needs a DOM document. " +
        "Use getIconSvg(name) for the SVG string instead.",
    );
  }
  const holder = doc.createElement("div");
  holder.innerHTML = getIconSvg(name, options);
  const element = (holder as unknown as { firstChild: unknown }).firstChild;
  if (!element) throw new Error("[@vantail/icons] Failed to create icon element.");
  return element as SVGElement;
}
