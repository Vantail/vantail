/**
 * Registry entry point (hand-written shim over generated code).
 *
 * The catalogue itself — `icons`, `iconNames`, `IconName`, `isIconName` —
 * lives in `./icons.generated.js`, written by `scripts/generate-icons.mjs`
 * from the installed `lucide` package. This file only re-exports it so the
 * `./icons.js` import path keeps working.
 */

export { icons, iconNames, isIconName } from "./icons.generated.js";
export type { IconName } from "./icons.generated.js";
