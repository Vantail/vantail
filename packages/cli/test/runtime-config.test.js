import assert from "node:assert/strict";
import { test } from "node:test";

import { resolve } from "node:path";

import { buildRuntimeConfig } from "../dist/runtime-config.js";
import { safeName } from "../dist/bundle/common.js";

const config = {
  app: { name: "My App", identifier: "dev.wissen.myapp", version: "1.2.3" },
  window: { width: 800, height: 600 },
  permissions: { dialog: true },
};

test("a dev config points the webview at the dev server", () => {
  const runtime = buildRuntimeConfig({ config, root: "/projects/app", devUrl: "http://localhost:5173/" });

  assert.deepEqual(runtime.dev, { url: "http://localhost:5173/" });
  // Devtools default to on in dev and off otherwise.
  assert.equal(runtime.devtools, true);
  // Nothing is built yet, so resources still resolve to where a build lands.
  // Compared against `resolve` rather than a literal: an absolute path is
  // spelled differently on Windows.
  assert.equal(runtime.distDir, resolve("/projects/app", "dist"));
});

test("a packaged config has no dev server and a relative resource dir", () => {
  const runtime = buildRuntimeConfig({ config, root: "/projects/app", distDir: "dist" });

  assert.equal(runtime.dev, undefined);
  assert.equal(runtime.devtools, false);
  assert.equal(runtime.distDir, "dist");
});

test("an explicit devtools setting wins over the default", () => {
  const runtime = buildRuntimeConfig({
    config: { ...config, devtools: true },
    root: "/projects/app",
    distDir: "dist",
  });
  assert.equal(runtime.devtools, true);
});

test("a missing version becomes 0.0.0 rather than undefined", () => {
  const runtime = buildRuntimeConfig({
    config: { app: { name: "A", identifier: "a.b" } },
    root: "/projects/app",
  });
  assert.equal(runtime.app.version, "0.0.0");
});

test("bundle names survive spaces and punctuation", () => {
  assert.equal(safeName("My App"), "My-App");
  assert.equal(safeName("Jeroen's Notes!"), "Jeroens-Notes");
  assert.equal(safeName("...."), "....");
  assert.equal(safeName("日本語"), "app");
});
