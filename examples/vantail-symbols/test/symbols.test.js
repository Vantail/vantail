/**
 * Vantail Symbols example tests: pure application logic in `src/lib.ts`.
 *
 * The module under test imports nothing, so these run with plain
 * `node --test` — no bundler, no DOM, no network. Run from the example
 * directory:
 *
 * ```sh
 * node --test test/symbols.test.js
 * ```
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clampSize,
  clampStrokeWidth,
  DEFAULT_COLOR,
  DEFAULT_SIZE,
  DEFAULT_STROKE_WIDTH,
  FAVORITES_KEY,
  filterIconNames,
  GRID_PAGE,
  loadNameList,
  MAX_SIZE,
  MIN_SIZE,
  normalizePreviewColor,
  normalizeQuery,
  pushRecent,
  reactSnippet,
  RECENT_KEY,
  RECENT_MAX,
  sanitizeNameList,
  saveNameList,
  snippetProps,
  toggleFavorite,
  vanillaSnippet,
} from "../src/lib.ts";

const NAMES = ["house", "house-plus", "search", "settings", "user", "zap"];
const isKnown = (name) => NAMES.includes(name);

function memoryStorage(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => void store.set(key, value),
  };
}

describe("search", () => {
  it("matches case-insensitively on partial names", () => {
    assert.deepEqual(filterIconNames(NAMES, "HOUSE"), ["house", "house-plus"]);
    assert.deepEqual(filterIconNames(NAMES, " Hou "), ["house", "house-plus"]);
    assert.deepEqual(filterIconNames(NAMES, "s"), [
      "house",
      "house-plus",
      "search",
      "settings",
      "user",
    ]);
  });

  it("returns the whole list on an empty query without aliasing it", () => {
    const result = filterIconNames(NAMES, "   ");
    assert.deepEqual(result, NAMES);
    assert.notEqual(result, NAMES);
  });

  it("returns an empty list when nothing matches", () => {
    assert.deepEqual(filterIconNames(NAMES, "definitely-not-an-icon"), []);
  });

  it("normalizes queries by trimming and lowercasing", () => {
    assert.equal(normalizeQuery("  Rocket "), "rocket");
  });
});

describe("preview option clamping", () => {
  it("clamps sizes into range and rejects non-numbers", () => {
    assert.equal(clampSize(32), 32);
    assert.equal(clampSize(33.6), 34);
    assert.equal(clampSize(4), MIN_SIZE);
    assert.equal(clampSize(400), MAX_SIZE);
    assert.equal(clampSize(Number.NaN), 48);
    assert.equal(clampSize("32"), 48);
  });

  it("snaps stroke widths to quarter steps within range", () => {
    assert.equal(clampStrokeWidth(1.5), 1.5);
    assert.equal(clampStrokeWidth(1.73), 1.75);
    assert.equal(clampStrokeWidth(0), 0.5);
    assert.equal(clampStrokeWidth(9), 3);
    assert.equal(clampStrokeWidth(Number.POSITIVE_INFINITY), DEFAULT_STROKE_WIDTH);
  });

  it("falls back to currentColor for blank colors", () => {
    assert.equal(normalizePreviewColor(" crimson "), "crimson");
    assert.equal(normalizePreviewColor(""), DEFAULT_COLOR);
    assert.equal(normalizePreviewColor(undefined), DEFAULT_COLOR);
  });
});

describe("code generation", () => {
  it("omits default props from both snippets", () => {
    const options = { size: DEFAULT_SIZE, strokeWidth: DEFAULT_STROKE_WIDTH, color: DEFAULT_COLOR };
    assert.equal(
      vanillaSnippet("house", options),
      'import { getIconSvg } from "@vantail/icons";\n' +
        '\n' +
        'document.body.innerHTML = getIconSvg("house");',
    );
    assert.equal(
      reactSnippet("house", options),
      'import { Icon } from "@vantail/icons/react";\n' + '\n' + '<Icon name="house" />',
    );
    assert.deepEqual(snippetProps(options), []);
  });

  it("reflects adjusted size, stroke, and color", () => {
    const options = { size: 32, strokeWidth: 1.5, color: "crimson" };
    const vanilla = vanillaSnippet("folder-open", options);
    assert.match(vanilla, /getIconSvg\("folder-open", \{ size: 32, strokeWidth: 1\.5, color: "crimson" \}\)/);
    const react = reactSnippet("folder-open", options);
    assert.match(react, /<Icon name="folder-open" size=\{32\} strokeWidth=\{1\.5\} color="crimson" \/>/);
  });

  it("escapes quotes in names and colors", () => {
    const colored = { size: DEFAULT_SIZE, strokeWidth: DEFAULT_STROKE_WIDTH, color: 'a"b' };
    assert.match(reactSnippet("house", colored), /color="a\\"b"/);
    const plain = { size: DEFAULT_SIZE, strokeWidth: DEFAULT_STROKE_WIDTH, color: DEFAULT_COLOR };
    assert.match(vanillaSnippet('a"b', plain), /getIconSvg\("a\\"b"\)/);
  });
});

describe("favorites", () => {
  it("toggles membership while preserving order", () => {
    assert.deepEqual(toggleFavorite(["house", "zap"], "search"), {
      names: ["house", "zap", "search"],
      added: true,
    });
    assert.deepEqual(toggleFavorite(["house", "zap"], "house"), {
      names: ["zap"],
      added: false,
    });
  });
});

describe("recently viewed", () => {
  it("is most-recent-first with duplicates removed", () => {
    assert.deepEqual(pushRecent(["search", "house"], "zap", isKnown), [
      "zap",
      "search",
      "house",
    ]);
    assert.deepEqual(pushRecent(["search", "house"], "search", isKnown), [
      "search",
      "house",
    ]);
  });

  it("is bounded", () => {
    const full = Array.from({ length: RECENT_MAX }, (_, i) => `icon-${i}`);
    const next = pushRecent(full, "zap", () => true);
    assert.equal(next.length, RECENT_MAX);
    assert.equal(next[0], "zap");
  });

  it("ignores unknown names", () => {
    assert.deepEqual(pushRecent(["house"], "not-an-icon", isKnown), ["house"]);
  });
});

describe("local persistence", () => {
  it("round-trips favorites and recents through storage", () => {
    const storage = memoryStorage();
    assert.equal(saveNameList(storage, FAVORITES_KEY, ["house", "zap"]), true);
    assert.equal(saveNameList(storage, RECENT_KEY, ["search"]), true);
    assert.deepEqual(loadNameList(storage, FAVORITES_KEY, isKnown), ["house", "zap"]);
    assert.deepEqual(loadNameList(storage, RECENT_KEY, isKnown), ["search"]);
  });

  it("drops unknown, duplicate, and non-string entries on load", () => {
    const storage = memoryStorage({
      [FAVORITES_KEY]: JSON.stringify(["house", "gone", "house", 42, null, "zap"]),
    });
    assert.deepEqual(loadNameList(storage, FAVORITES_KEY, isKnown), ["house", "zap"]);
  });

  it("treats missing, corrupt, or throwing storage as empty", () => {
    assert.deepEqual(loadNameList(undefined, FAVORITES_KEY, isKnown), []);
    assert.deepEqual(
      loadNameList(memoryStorage({ [RECENT_KEY]: "{nope" }), RECENT_KEY, isKnown),
      [],
    );
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    assert.deepEqual(loadNameList(throwing, FAVORITES_KEY, isKnown), []);
    assert.equal(saveNameList(throwing, FAVORITES_KEY, ["house"]), false);
    assert.equal(saveNameList(undefined, FAVORITES_KEY, ["house"]), false);
  });

  it("sanitizes non-array payloads", () => {
    assert.deepEqual(sanitizeNameList({ house: true }, isKnown), []);
    assert.deepEqual(sanitizeNameList("house", isKnown), []);
  });
});

describe("conventions", () => {
  it("keeps the grid page size well below the catalogue size", () => {
    // The grid must page rather than render everything at once; a page that
    // ever approaches the catalogue size has lost the plot.
    assert.ok(GRID_PAGE > 0 && GRID_PAGE <= 500, `GRID_PAGE is ${GRID_PAGE}`);
  });
});
