/**
 * Shared React renderer: Lucide node to `<svg>` element.
 *
 * `BaseIconProps` is the option shape every icon component takes; generic
 * lookup (`Icon`) and generated static components (`House`, …) both render
 * through `baseReactIcon`, so both draw identically. Static components pass
 * their own artwork node directly and never touch the name registry, which
 * is what keeps them tree-shakeable.
 */

import { createElement, type ReactElement, type SVGProps } from "react";

import { normalizeColor, normalizeSize, normalizeStrokeWidth } from "./shared.js";
import type { IconNode, IconOptions } from "./types.js";

export interface BaseIconProps
  extends IconOptions,
    Omit<
      SVGProps<SVGSVGElement>,
      "width" | "height" | "color" | "strokeWidth" | "aria-label" | "aria-hidden"
    > {}

export function baseReactIcon(
  node: IconNode,
  iconKey: string,
  known: boolean,
  props: BaseIconProps,
): ReactElement {
  const { size, strokeWidth, color, label, className, ...rest } = props;
  const resolvedSize = normalizeSize(size);
  const resolvedStroke = normalizeStrokeWidth(strokeWidth);
  const resolvedColor = normalizeColor(color);
  const text = typeof label === "string" ? label.trim() : "";
  const classes = ["vantail-icon"];
  if (typeof className === "string" && className.trim() !== "") classes.push(className.trim());

  const a11y =
    text !== "" ? { role: "img" as const, "aria-label": text } : { "aria-hidden": true as const };

  // Strip width/height if a caller smuggled them through `rest`.
  const { width: _w, height: _h, ...safeRest } = rest as Record<string, unknown>;

  return createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: resolvedSize,
      height: resolvedSize,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: resolvedColor,
      strokeWidth: resolvedStroke,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      className: classes.join(" "),
      "data-icon": iconKey,
      ...(known ? null : { "data-unknown": "true" }),
      ...a11y,
      ...safeRest,
    },
    node.map(([tag, attrs], index) => createElement(tag, { key: index, ...attrs })),
  );
}
