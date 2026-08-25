import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { findConfigFile, loadConfig } from "../dist/load.js";

const roots = [];

async function project(source, name = "vantail.config.ts") {
  const root = await mkdtemp(join(tmpdir(), "vantail-load-"));
  roots.push(root);
  await writeFile(join(root, name), source, "utf8");
  return root;
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("loads a TypeScript config with types and imports", async () => {
  const root = await project(`
    interface Extra { note: string }
    const extra: Extra = { note: "stripped at load time" };
    export default {
      app: { name: "Loaded " + extra.note.length, identifier: "dev.vantail.loaded" },
      window: { width: 640 },
    };
  `);

  const loaded = await loadConfig({ cwd: root });
  assert.equal(loaded.config.app.identifier, "dev.vantail.loaded");
  assert.equal(loaded.config.window.width, 640);
  assert.equal(loaded.root, root);
});

test("searches parent directories", async () => {
  const root = await project(`
    export default { app: { name: "Parent", identifier: "dev.vantail.parent" } };
  `);
  const found = findConfigFile(join(root, "src", "deep"));
  assert.equal(found, join(root, "vantail.config.ts"));
});

test("an invalid config reports every problem at once", async () => {
  const root = await project(`
    export default { app: { name: "", identifier: "nodots" } };
  `);

  await assert.rejects(loadConfig({ cwd: root }), (error) => {
    assert.equal(error.name, "ConfigError");
    assert.equal(error.problems.length, 2);
    return true;
  });
});

test("a missing config says where it looked", async () => {
  const root = await mkdtemp(join(tmpdir(), "vantail-empty-"));
  roots.push(root);
  await assert.rejects(loadConfig({ cwd: root }), /No vantail.config.ts found/);
});

test("the temporary bundle is cleaned up", async () => {
  const root = await project(`
    export default { app: { name: "Tidy", identifier: "dev.vantail.tidy" } };
  `);
  await loadConfig({ cwd: root });
  assert.deepEqual(readdirSync(root), ["vantail.config.ts"]);
});

test("a config that throws does not leave the bundle behind", async () => {
  const root = await project(`
    throw new Error("boom");
  `);
  await assert.rejects(loadConfig({ cwd: root }), /boom/);
  assert.deepEqual(readdirSync(root), ["vantail.config.ts"]);
});
