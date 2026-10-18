/**
 * `@vantail/icons/react` — React adapter over the same Lucide nodes as the
 * vanilla API, so both draw identically.
 *
 * Dynamic usage (supports the full catalogue; bundles it — see README):
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

import type { ReactElement } from "react";

import { resolveIcon } from "./shared.js";
import { baseReactIcon, type BaseIconProps } from "./react-base.js";
import type { IconName, IconOptions } from "./types.js";

export type { IconName, IconOptions };
export type { BaseIconProps } from "./react-base.js";
export * from "./react.generated.js";

export interface StaticIconProps extends BaseIconProps {}

export interface IconProps extends BaseIconProps {
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
export function Icon({ name, ...props }: IconProps): ReactElement {
  const { node, known, key } = resolveIcon(name);
  return baseReactIcon(node, key, known, props);
}
