/**
 * A template that does not validate is a broken `npm create`, and nobody
 * finds out until someone tries it. So every template's config goes through
 * the same schema the CLI uses.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseConfig } from "@vantail/shared/schema";

const templatesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);
const templates = (await readdir(templatesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/**
 * Evaluate a template config without installing anything.
 *
 * `defineConfig` is an identity function, so dropping the import and
 * supplying one locally gives the same object the CLI would load - and does
 * not need the scaffolded project's `node_modules` to exist.
 */
async function loadTemplateConfig(template) {
  const source = await readFile(
    join(templatesRoot, template, "vantail.config.ts"),
    "utf8",
  );
  const body = source
    .replace(/^import .*$/m, "const defineConfig = (config) => config;")
    .replaceAll("__APP_NAME__", "Test App")
    .replaceAll("__APP_IDENTIFIER__", "com.example.testapp");

  const module = await import(
    `data:text/javascript,${encodeURIComponent(body)}`
  );
  return module.default;
}

test("there is at least one template", () => {
  assert.ok(templates.length > 0);
});

/**
 * The scaffolder self-executes and exports nothing, so the list it offers has
 * to be read out of its source - the same trick this file already plays on
 * the template configs.
 */
async function offeredTemplates() {
  const source = await readFile(
    join(templatesRoot, "..", "src", "index.ts"),
    "utf8",
  );
  const block = /const TEMPLATES = \[(.*?)\] as const;/s.exec(source);
  assert.ok(block, "could not find the TEMPLATES list in src/index.ts");
  return [...block[1].matchAll(/id:\s*"([^"]+)"/g)].map((match) => match[1]);
}

test("every template on disk is one the scaffolder offers", async () => {
  const offered = await offeredTemplates();

  // A template directory missing from the list is invisible: nothing can
  // choose it, and nothing says so.
  for (const template of templates) {
    assert.ok(
      offered.includes(template),
      `${template} exists but is not in TEMPLATES`,
    );
  }
  // And the reverse, which fails at `cp` time with a confusing error.
  for (const id of offered) {
    assert.ok(
      templates.includes(id),
      `TEMPLATES offers ${id}, but there is no such directory`,
    );
  }
});

for (const template of templates) {
  test(`${template} produces a valid config`, async () => {
    const result = parseConfig(await loadTemplateConfig(template));
    assert.equal(result.ok, true, result.ok ? "" : result.problems.join("; "));
  });

  test(`${template} ships a working macOS menu`, async () => {
    const config = await loadTemplateConfig(template);

    // Without these in the menu, the shortcuts do not work at all on macOS -
    // which is a terrible first impression for a new project.
    const predefined = JSON.stringify(config.menu);
    for (const item of ["copy", "paste", "undo", "selectAll", "quit"]) {
      assert.ok(
        predefined.includes(`"${item}"`),
        `${template} has no ${item} menu item`,
      );
    }
    assert.equal(
      config.permissions.menu,
      true,
      `${template} sets a menu but cannot install it`,
    );
  });

  test(`${template} grants nothing it does not use`, async () => {
    const config = await loadTemplateConfig(template);
    // A starter template is where bad habits get copied from.
    assert.equal(config.permissions.filesystem?.read, undefined);
    assert.equal(config.permissions.shell, undefined);
    assert.equal(config.permissions.updater, undefined);
  });
}
