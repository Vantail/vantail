/**
 * Catalogue completeness: the generated registry matches the eligible icon
 * exports of the installed `lucide` version — no more, no fewer.
 *
 * Eligibility is re-derived here independently from the installed package
 * (file-backed icons in lucide's dist), so this test fails if the generator
 * drifts, admits aliases, or drops icons. Counts are asserted as thresholds,
 * not exact numbers, so Lucide upgrades only require regeneration.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { getIconSvg, iconNames, icons, isIconName } from "../dist/index.js";
import { resetUnknownIconWarnings } from "../dist/shared.js";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(pkgDir, "package.json"));
const lucideDir = dirname(require.resolve("lucide/package.json"));
const iconsDir = join(lucideDir, "dist", "esm", "icons");

/** Eligible catalogue, derived independently from the installed package. */
function eligibleCatalogue() {
  const entries = [];
  for (const file of readdirSync(iconsDir).filter((f) => f.endsWith(".mjs")).sort()) {
    const kebab = file.slice(0, -".mjs".length);
    const src = readFileSync(join(iconsDir, file), "utf8");
    const pascal = src.match(/^const ([A-Za-z0-9]+) = /m)?.[1];
    assert.ok(pascal, `unparseable icon file in test: ${file}`);
    entries.push({ kebab, pascal });
  }
  return entries;
}

test("catalogue matches every file-backed icon in the installed lucide", () => {
  const expected = eligibleCatalogue().map((entry) => entry.kebab).sort();
  assert.deepEqual([...iconNames].sort(), expected);
});

test("catalogue is substantially larger than the original 57-icon subset", () => {
  assert.ok(iconNames.length > 1000, `expected >1000 icons, got ${iconNames.length}`);
  assert.ok(iconNames.length > 57 * 10);
});

test("names are unique canonical kebab-case", () => {
  assert.equal(new Set(iconNames).size, iconNames.length);
  for (const name of iconNames) {
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `non-canonical name: ${name}`);
  }
  assert.deepEqual([...iconNames].sort(), [...iconNames]);
});

test("representative icons from across the catalogue resolve", () => {
  const across = [
    "house", // original subset still works
    "settings",
    "folder-open",
    "arrow-left",
    "rocket", // outside the original subset
    "funnel",
    "ellipsis",
    "a-arrow-down",
    "zoom-out",
    "satellite",
    "banknote",
    "sailboat",
  ];
  for (const name of across) {
    assert.ok(isIconName(name), `${name} should be a known icon`);
    const svg = getIconSvg(name);
    assert.match(svg, new RegExp(`data-icon="${name}"`));
    assert.doesNotMatch(svg, /data-unknown/);
  }
});

test("every registered name resolves without the unknown placeholder", () => {
  for (const name of iconNames) {
    const svg = getIconSvg(name);
    if (svg.includes("data-unknown")) {
      assert.fail(`${name} rendered the unknown placeholder`);
    }
  }
});

test("aliases, helpers, and non-icons are rejected", () => {
  const original = console.warn;
  console.warn = () => {};
  try {
    for (const name of [
      "Home", // alias of house
      "AlertTriangle", // alias of triangle-alert
      "Trash2", // alias of trash
      "ActivitySquare", // alias of square-activity
      "CheckCircle", // superseded, no file of its own
      "Edit", // superseded by pen/pen-line
      "createElement", // helper export, not artwork
      "icons", // registry object export, not artwork
      "",
      "not-an-icon",
    ]) {
      assert.equal(isIconName(name), false, `${name} should be rejected`);
      assert.match(getIconSvg(name), /data-unknown="true"/, `${name} should render the placeholder`);
    }
    assert.ok(!("Home" in icons));
  } finally {
    console.warn = original;
    resetUnknownIconWarnings();
  }
});

test("regeneration is deterministic (no churn without a lucide change)", () => {
  const targets = ["src/icons.generated.ts", "src/react.generated.ts"];
  const before = targets.map((file) => readFileSync(join(pkgDir, file), "utf8"));
  execFileSync(process.execPath, ["scripts/generate-icons.mjs"], { cwd: pkgDir, stdio: "pipe" });
  targets.forEach((file, index) => {
    assert.equal(readFileSync(join(pkgDir, file), "utf8"), before[index], `${file} changed on regen`);
  });
});
