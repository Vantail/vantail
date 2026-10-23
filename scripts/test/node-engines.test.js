/**
 * The Node floor is repeated across the manifests whose code runs under Node,
 * and in the templates a new project starts from. Duplicating it is
 * unavoidable - `engines` is per package - so this is what keeps the copies
 * honest.
 *
 * That is the CLI and the scaffold, the runtime's resolver, the shared schema
 * and the Vite plugin. `@vantail/api` and `@vantail/icons` ship code that runs
 * in a webview or a browser, so they declare no engine and are not listed.
 *
 * 22.23.4, 24.22.1 and 26.12.1 are the releases with the Brotli decoder fix
 * (CVE-2026-111497). Node 20 is end-of-life and never receives it.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUPPORTED = "^22.23.4 || ^24.22.1 || >=26.12.1";

const manifests = [
  "package.json",
  "packages/cli/package.json",
  "packages/create/package.json",
  "packages/runtime/package.json",
  "packages/shared/package.json",
  "packages/vite/package.json",
];

test("packages that run under Node declare a patched engine", async () => {
  for (const path of manifests) {
    const manifest = JSON.parse(await readFile(join(root, path), "utf8"));
    assert.equal(manifest.engines?.node, SUPPORTED, path);
  }
});

test("scaffolded projects declare the same engine", async () => {
  const templates = (
    await readdir(join(root, "packages/create/templates"), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/create/templates/${entry.name}/package.json`);

  assert.ok(templates.length > 0);

  for (const path of templates) {
    const manifest = JSON.parse(await readFile(join(root, path), "utf8"));
    assert.equal(manifest.engines?.node, SUPPORTED, path);
  }
});
