/**
 * Bundle behavior with the actual production toolchain (Vite/Rollup):
 *
 * - Static named imports (`import { House }`) ship only that icon.
 * - Dynamic lookup (`Icon`) supports the full catalogue and bundles it.
 *
 * Probes are derived from the built registry at test time, so they stay
 * valid across Lucide upgrades. Sizes are printed for the docs.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { icons } from "../dist/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function artworkProbe(name) {
  const node = icons[name];
  assert.ok(node, `probe icon missing from registry: ${name}`);
  for (const [, attrs] of node) {
    const d = attrs?.d;
    if (typeof d === "string" && d.length >= 24) return d.slice(0, 24);
  }
  throw new Error(`no path data to probe for ${name}`);
}

async function buildFixture(entry) {
  const { build } = await import("vite");
  const outDir = mkdtempSync(join(tmpdir(), "vantail-icons-bundle-"));
  try {
    await build({
      root: fixtures,
      logLevel: "silent",
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
        lib: { entry: join(fixtures, entry), formats: ["es"], fileName: () => "bundle.js" },
      },
    });
    return { outDir, js: readFileSync(join(outDir, "bundle.js"), "utf8") };
  } catch (error) {
    rmSync(outDir, { recursive: true, force: true });
    throw error;
  }
}

test("static named imports ship only the imported icon", async () => {
  const house = "M15 21v-8"; // House artwork spot-check (matches registry test)
  const rare = artworkProbe("a-arrow-down");
  const { outDir, js } = await buildFixture("static-entry.js");
  try {
    assert.ok(js.includes(house), "static bundle should contain House artwork");
    assert.ok(!js.includes(rare), "static bundle should not contain unrelated catalogue artwork");
    console.log(`[bundles] static-only: ${(js.length / 1024).toFixed(1)} kB`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("dynamic lookup supports the full catalogue (and bundles it)", async () => {
  const house = "M15 21v-8";
  const rare = artworkProbe("a-arrow-down");
  const { outDir, js } = await buildFixture("dynamic-entry.js");
  try {
    assert.ok(js.includes(house), "dynamic bundle should contain House artwork");
    assert.ok(js.includes(rare), "dynamic bundle should contain full-catalogue artwork");
    console.log(`[bundles] dynamic Icon: ${(js.length / 1024).toFixed(1)} kB`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
