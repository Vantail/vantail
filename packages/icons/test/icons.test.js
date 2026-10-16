/**
 * Vanilla API tests: pure SVG strings, no DOM needed.
 *
 * Run after `pnpm --filter @vantail/icons run build`:
 *   node --test packages/icons/test/*.test.js
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createIconElement,
  getIconSvg,
  iconNames,
  icons,
  isIconName,
} from "../dist/index.js";
import { resetUnknownIconWarnings } from "../dist/shared.js";

function captureWarnings(run) {
  const original = console.warn;
  const messages = [];
  console.warn = (message) => messages.push(String(message));
  try {
    run();
  } finally {
    console.warn = original;
    resetUnknownIconWarnings();
  }
  return messages;
}

test("valid icon names render an SVG with the Lucide artwork", () => {
  const svg = getIconSvg("house");
  assert.match(svg, /^<svg /);
  assert.match(svg, /data-icon="house"/);
  // Spot-check against the official Lucide path data for House.
  assert.match(svg, /M15 21v-8/);
  assert.match(svg, /<\/svg>$/);
});

test("catalogue exposes canonical names only", () => {
  assert.ok(iconNames.includes("house"));
  assert.ok(iconNames.includes("settings"));
  assert.ok(iconNames.includes("folder-open"));
  assert.deepEqual([...iconNames].sort(), [...iconNames]);
  assert.ok(!("Home" in icons));
  assert.ok(!("HOUSE" in icons));
});

test("defaults: 24px, stroke-width 2, currentColor, decorative", () => {
  const svg = getIconSvg("heart");
  assert.match(svg, /width="24"/);
  assert.match(svg, /height="24"/);
  assert.match(svg, /stroke-width="2"/);
  assert.match(svg, /stroke="currentColor"/);
  assert.match(svg, /fill="none"/);
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /aria-hidden="true"/);
  assert.doesNotMatch(svg, /role="img"/);
});

test("size, strokeWidth and color are applied", () => {
  const svg = getIconSvg("settings", { size: 20, strokeWidth: 1.5, color: "red" });
  assert.match(svg, /width="20"/);
  assert.match(svg, /height="20"/);
  assert.match(svg, /stroke-width="1.5"/);
  assert.match(svg, /stroke="red"/);
});

test("strokeWidth 0 is allowed (filled shapes stay visible)", () => {
  assert.match(getIconSvg("heart", { strokeWidth: 0 }), /stroke-width="0"/);
});

test("invalid size/strokeWidth/color fall back to defaults", () => {
  for (const size of [0, -4, Number.NaN, Number.POSITIVE_INFINITY, "20"]) {
    assert.match(
      getIconSvg("x", { size }),
      /width="24"/,
      `size ${String(size)} should fall back to 24`,
    );
  }
  for (const strokeWidth of [-1, Number.NaN, Number.POSITIVE_INFINITY, "2"]) {
    assert.match(
      getIconSvg("x", { strokeWidth }),
      /stroke-width="2"/,
      `strokeWidth ${String(strokeWidth)} should fall back to 2`,
    );
  }
  for (const color of ["", "   ", undefined, 42]) {
    assert.match(
      getIconSvg("x", { color }),
      /stroke="currentColor"/,
      `color ${String(color)} should fall back to currentColor`,
    );
  }
});

test("label makes the icon exposed with role=img; otherwise decorative", () => {
  const labelled = getIconSvg("search", { label: "Search" });
  assert.match(labelled, /role="img"/);
  assert.match(labelled, /aria-label="Search"/);
  assert.doesNotMatch(labelled, /aria-hidden/);

  const blank = getIconSvg("search", { label: "   " });
  assert.match(blank, /aria-hidden="true"/);
});

test("labels and colors are HTML-escaped (no attribute injection)", () => {
  const svg = getIconSvg("bell", { label: '"><script>alert(1)</script>' });
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /aria-label="&quot;&gt;&lt;script&gt;/);

  const colored = getIconSvg("bell", { color: 'red" onload="evil()' });
  assert.doesNotMatch(colored, /onload="evil/);
  assert.match(colored, /stroke="red&quot; onload/);
});

test("unknown names render a placeholder and warn once per name", () => {
  const messages = captureWarnings(() => {
    const first = getIconSvg("not-a-lucide-icon");
    const second = getIconSvg("not-a-lucide-icon");
    assert.match(first, /data-unknown="true"/);
    assert.match(first, /data-icon="not-a-lucide-icon"/);
    assert.match(first, /^<svg /);
    assert.match(second, /data-unknown="true"/);
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Unknown icon "not-a-lucide-icon"/);
});

test("names are trimmed but case-sensitive (canonical kebab-case only)", () => {
  assert.match(getIconSvg("  house  "), /data-icon="house"/);
  assert.doesNotMatch(getIconSvg("  house  "), /data-unknown/);
  captureWarnings(() => {
    assert.match(getIconSvg("House"), /data-unknown="true"/);
    assert.match(getIconSvg("HOUSE"), /data-unknown="true"/);
    assert.match(getIconSvg(""), /data-unknown="true"/);
  });
});

test("extraAttrs pass through escaped; booleans and undefined handled", () => {
  const svg = getIconSvg("star", {
    className: "favorite",
    extraAttrs: {
      "data-testid": "icon-star",
      "data-note": 'a"b',
      hidden: true,
      disabled: false,
      title: undefined,
    },
  });
  assert.match(svg, /class="vantail-icon favorite"/);
  assert.match(svg, /data-testid="icon-star"/);
  assert.match(svg, /data-note="a&quot;b"/);
  assert.match(svg, / hidden=""/);
  assert.doesNotMatch(svg, /disabled=/);
  assert.doesNotMatch(svg, /title=/);
});

test("isIconName narrows known names only", () => {
  assert.equal(isIconName("house"), true);
  assert.equal(isIconName("folder-open"), true);
  assert.equal(isIconName("House"), false);
  assert.equal(isIconName("nope"), false);
  assert.equal(isIconName(""), false);
  assert.equal(isIconName(undefined), false);
  assert.equal(isIconName(42), false);
});

test("createIconElement builds an element with a stub document", () => {
  let inner = "";
  const stub = {
    createElement() {
      return {
        set innerHTML(value) {
          inner = value;
        },
        get firstChild() {
          return { svg: inner };
        },
      };
    },
  };
  const element = createIconElement("menu", { size: 18 }, stub);
  assert.match(element.svg, /data-icon="menu"/);
  assert.match(element.svg, /width="18"/);
});

test("createIconElement without a DOM throws a helpful error", () => {
  assert.throws(
    () => createIconElement("menu", {}, undefined),
    /needs a DOM document.*getIconSvg/s,
  );
});
