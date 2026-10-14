/**
 * `@vantail/icons/react` — React adapter over the same Lucide nodes as the
 * vanilla API, so both draw identically.
 *
 * Dynamic usage (bundles the curated set):
 * ```tsx
 * import { Icon } from "@vantail/icons/react";
 * <Icon name="house" size={20} />
 * ```
 *
 * Static usage (best tree-shaking — only imported icons ship):
 * ```tsx
 * import { House, Settings } from "@vantail/icons/react";
 * <House size={20} />
 * ```
 */

import { createElement } from "react";
import type { SVGProps } from "react";

import { normalizeColor, normalizeSize, normalizeStrokeWidth, resolveIcon } from "./shared.js";
import type { IconName, IconOptions } from "./types.js";

export type { IconName, IconOptions };

export interface IconProps extends IconOptions, Omit<SVGProps<SVGSVGElement>, "width" | "height" | "color" | "strokeWidth" | "aria-label" | "aria-hidden"> {
  /** Canonical Lucide name, e.g. `"house"`. Unknown names render a placeholder. */
  name: IconName | (string & {});
}

/**
 * Render a Lucide icon by name.
 *
 * - `size` sets `width`/`height` (default 24; non-finite or <= 0 falls back).
 * - `strokeWidth` defaults to 2; `color` defaults to `currentColor`.
 * - `label` gives `role="img"` + `aria-label`; otherwise `aria-hidden`.
 * - Unknown names render a placeholder and warn once per name in dev.
 */
export function Icon({ name, size, strokeWidth, color, label, className, ...rest }: IconProps) {
  const { node, known, key } = resolveIcon(name);
  const resolvedSize = normalizeSize(size);
  const resolvedStroke = normalizeStrokeWidth(strokeWidth);
  const resolvedColor = normalizeColor(color);
  const text = typeof label === "string" ? label.trim() : "";
  const classes = ["vantail-icon"];
  if (typeof className === "string" && className.trim() !== "") classes.push(className.trim());

  const a11y =
    text !== ""
      ? { role: "img" as const, "aria-label": text }
      : { "aria-hidden": true as const };

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
      "data-icon": key,
      ...(known ? null : { "data-unknown": "true" }),
      ...a11y,
      ...safeRest,
    },
    node.map(([tag, attrs], index) => createElement(tag, { key: index, ...attrs })),
  );
}

export type StaticIconProps = Omit<IconProps, "name">;

function staticIcon(name: IconName) {
  function NamedIcon(props: StaticIconProps) {
    return createElement(Icon, { ...props, name });
  }
  NamedIcon.displayName = `${name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}Icon`;
  return NamedIcon;
}

/** Static, maximally tree-shakeable components — one per curated icon. */
export const Archive = staticIcon("archive");
export const ArrowLeft = staticIcon("arrow-left");
export const ArrowRight = staticIcon("arrow-right");
export const Bell = staticIcon("bell");
export const Bookmark = staticIcon("bookmark");
export const Calendar = staticIcon("calendar");
export const Camera = staticIcon("camera");
export const Check = staticIcon("check");
export const ChevronDown = staticIcon("chevron-down");
export const ChevronLeft = staticIcon("chevron-left");
export const ChevronRight = staticIcon("chevron-right");
export const CircleCheck = staticIcon("circle-check");
export const CircleX = staticIcon("circle-x");
export const Clock = staticIcon("clock");
export const Copy = staticIcon("copy");
export const Download = staticIcon("download");
export const ExternalLink = staticIcon("external-link");
export const Eye = staticIcon("eye");
export const EyeOff = staticIcon("eye-off");
export const FileText = staticIcon("file-text");
export const Folder = staticIcon("folder");
export const FolderOpen = staticIcon("folder-open");
export const Globe = staticIcon("globe");
export const Heart = staticIcon("heart");
export const House = staticIcon("house");
export const Image = staticIcon("image");
export const Inbox = staticIcon("inbox");
export const Info = staticIcon("info");
export const LoaderCircle = staticIcon("loader-circle");
export const Lock = staticIcon("lock");
export const LogOut = staticIcon("log-out");
export const Mail = staticIcon("mail");
export const Menu = staticIcon("menu");
export const MessageSquare = staticIcon("message-square");
export const Mic = staticIcon("mic");
export const Pause = staticIcon("pause");
export const Pencil = staticIcon("pencil");
export const Phone = staticIcon("phone");
export const Play = staticIcon("play");
export const Plus = staticIcon("plus");
export const RefreshCw = staticIcon("refresh-cw");
export const Save = staticIcon("save");
export const Search = staticIcon("search");
export const Send = staticIcon("send");
export const Settings = staticIcon("settings");
export const Share2 = staticIcon("share-2");
export const SlidersHorizontal = staticIcon("sliders-horizontal");
export const Star = staticIcon("star");
export const TriangleAlert = staticIcon("triangle-alert");
export const Upload = staticIcon("upload");
export const User = staticIcon("user");
export const Users = staticIcon("users");
export const Video = staticIcon("video");
export const Volume2 = staticIcon("volume-2");
export const Wifi = staticIcon("wifi");
export const X = staticIcon("x");
export const Zap = staticIcon("zap");
