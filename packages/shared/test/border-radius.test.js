import assert from "node:assert/strict";
import { test } from "node:test";

import {
  borderRadiusWarning,
  hasBorderRadius,
  isFramelessOn,
} from "../dist/config.js";

test("a missing or zero radius rounds nothing", () => {
  assert.equal(hasBorderRadius(undefined), false);
  assert.equal(hasBorderRadius(0), false);
  assert.equal(hasBorderRadius({}), false);
  assert.equal(hasBorderRadius({ topLeft: 0, bottomRight: 0 }), false);
  assert.equal(hasBorderRadius(12), true);
  assert.equal(hasBorderRadius({ topLeft: 16 }), true);
});

test("a hidden title bar is frameless everywhere but macOS", () => {
  assert.equal(
    isFramelessOn({ titleBarStyle: "hidden" }, "linux"),
    true,
  );
  assert.equal(
    isFramelessOn({ titleBarStyle: "hidden" }, "win32"),
    true,
  );
  assert.equal(
    isFramelessOn({ titleBarStyle: "hidden" }, "darwin"),
    false,
  );
  assert.equal(
    isFramelessOn({ decorations: false }, "darwin"),
    true,
  );
  assert.equal(isFramelessOn({}, "linux"), false);
  assert.equal(isFramelessOn(undefined, "linux"), false);
});

test("borderRadius warns on Linux only, and only when it would round", () => {
  // Frameless with a radius: the combination the runtime ignores on Linux.
  assert.match(
    borderRadiusWarning({ decorations: false, borderRadius: 12 }, "linux") ?? "",
    /not supported on Linux/,
  );
  // Same config works elsewhere, so no warning.
  assert.equal(
    borderRadiusWarning({ decorations: false, borderRadius: 12 }, "darwin"),
    undefined,
  );
  assert.equal(
    borderRadiusWarning({ decorations: false, borderRadius: 12 }, "win32"),
    undefined,
  );
  // Nothing to ignore: no radius, a zero radius, or a framed window that
  // keeps the platform's corners anyway.
  assert.equal(borderRadiusWarning(undefined, "linux"), undefined);
  assert.equal(
    borderRadiusWarning({ decorations: false }, "linux"),
    undefined,
  );
  assert.equal(
    borderRadiusWarning({ decorations: false, borderRadius: 0 }, "linux"),
    undefined,
  );
  assert.equal(
    borderRadiusWarning({ borderRadius: 12 }, "linux"),
    undefined,
  );
});
