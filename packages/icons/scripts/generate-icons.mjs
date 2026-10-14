/**
 * Generate the `@vantail/icons` catalogue from the installed `lucide` package.
 *
 * Source of truth: `dist/esm/icons/*.mjs` inside the installed `lucide`
 * dependency. Each file is one canonical icon: the filename is the kebab-case
 * name (`folder-open`) and the file declares `const FolderOpen = [...]` with
 * `export { FolderOpen as default }`.
 *
 * Files are authoritative because the package root also re-exports deprecated
 * aliases (`Home`, `AlertTriangle`, …) which have no files of their own and
 * must stay out of the registry.
 *
 * No network access: everything is read from `node_modules`. Deterministic:
 * entries are sorted, formatting is fixed, files are only rewritten when the
 * content changed.
 *
 * Usage:
 *   pnpm --filter @vantail/icons run generate
 * Regenerate after every `lucide` upgrade, then run the test suite.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const lucidePkg = require.resolve("lucide/package.json");
const lucideDir = dirname(lucidePkg);
const lucideVersion = require("lucide/package.json").version;
const iconsDir = join(lucideDir, "dist", "esm", "icons");

const REQUIRED = ["house", "settings", "folder-open", "arrow-left"];
const MIN_ICONS = 1000;

const files = readdirSync(iconsDir)
  .filter((file) => file.endsWith(".mjs"))
  .sort();

const entries = [];
for (const file of files) {
  const kebab = file.slice(0, -".mjs".length);
  const src = readFileSync(join(iconsDir, file), "utf8");
  const declared = src.match(/^const ([A-Za-z0-9]+) = /m)?.[1];
  const exported = src.match(/export \{ ([A-Za-z0-9]+) as default \}/)?.[1];
  if (!declared || declared !== exported) {
    throw new Error(`[generate-icons] Cannot parse canonical export in ${file}`);
  }
  entries.push({ kebab, pascal: declared });
}

// The parsed names must all be real array exports of the installed package.
const lucide = await import("lucide");
for (const { kebab, pascal } of entries) {
  if (!Array.isArray(lucide[pascal])) {
    throw new Error(
      `[generate-icons] ${pascal} (from ${kebab}.mjs) is not an icon export of lucide@${lucideVersion}`,
    );
  }
}

entries.sort((a, b) => (a.kebab < b.kebab ? -1 : a.kebab > b.kebab ? 1 : 0));

const kebabs = new Set(entries.map((entry) => entry.kebab));
const pascals = new Set(entries.map((entry) => entry.pascal));
if (entries.length < MIN_ICONS) {
  throw new Error(`[generate-icons] Only ${entries.length} icons found, expected at least ${MIN_ICONS}`);
}
if (kebabs.size !== entries.length || pascals.size !== entries.length) {
  throw new Error("[generate-icons] Duplicate icon names detected");
}
for (const name of REQUIRED) {
  if (!kebabs.has(name)) {
    throw new Error(`[generate-icons] Required icon "${name}" missing from lucide@${lucideVersion}`);
  }
}

const pascalSorted = [...entries].sort((a, b) => (a.pascal < b.pascal ? -1 : a.pascal > b.pascal ? 1 : 0));
const importList = pascalSorted.map((entry) => `  ${entry.pascal},`).join("\n");
const nodeImportList = pascalSorted.map((entry) => `  ${entry.pascal} as ${entry.pascal}Node,`).join("\n");
const nodeOf = (pascal) => `${pascal}Node`;

const header = (what) => `/**
 * ${what}
 *
 * GENERATED from lucide@${lucideVersion} — do not edit by hand.
 * Regenerate with: pnpm --filter @vantail/icons run generate
 * Source of truth: dist/esm/icons/*.mjs in the installed lucide package
 * (filenames are canonical kebab-case names; files declare the artwork).
 */
`;

const registry =
  header("Canonical icon registry: kebab-case name to Lucide artwork.") +
  `import {\n${importList}\n} from "lucide";\n` +
  `import type { IconNode } from "lucide";\n` +
  `\n` +
  `export type IconName =\n` +
  entries.map((entry) => `  | "${entry.kebab}"`).join("\n") +
  `;\n` +
  `\n` +
  `export const icons: Record<IconName, IconNode> = {\n` +
  entries.map((entry) => `  "${entry.kebab}": ${entry.pascal},`).join("\n") +
  `\n};\n` +
  `\n` +
  `/** Every canonical name, sorted — for galleries and dynamic demos. */\n` +
  `export const iconNames: readonly IconName[] = [\n` +
  entries.map((entry) => `  "${entry.kebab}",`).join("\n") +
  `\n];\n` +
  `\n` +
  `/** Narrow an unknown string to a known icon name. */\n` +
  `export function isIconName(value: unknown): value is IconName {\n` +
  `  return typeof value === "string" && Object.hasOwn(icons, value);\n` +
  `}\n`;

const statics =
  header("Tree-shakeable React components — one per canonical icon.") +
  `import {\n${nodeImportList}\n} from "lucide";\n` +
  `import type { ReactElement } from "react";\n` +
  `import { baseReactIcon, type BaseIconProps } from "./react-base.js";\n` +
  `\n` +
  entries
    .map(
      (entry) =>
        `export function ${entry.pascal}(props: BaseIconProps): ReactElement {\n` +
        `  return baseReactIcon(${nodeOf(entry.pascal)}, "${entry.kebab}", true, props);\n` +
        `}`,
    )
    .join("\n\n") +
  `\n`;

const outDir = join(dirname(new URL(import.meta.url).pathname), "..", "src");
const targets = [
  ["icons.generated.ts", registry],
  ["react.generated.ts", statics],
];

for (const [filename, content] of targets) {
  const path = join(outDir, filename);
  let current = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // First generation: file does not exist yet.
  }
  if (current === content) {
    console.log(`[generate-icons] ${filename}: unchanged (${entries.length} icons, lucide@${lucideVersion})`);
  } else {
    writeFileSync(path, content);
    console.log(`[generate-icons] ${filename}: wrote ${entries.length} icons from lucide@${lucideVersion}`);
  }
}
