/**
 * The templates and the examples have to agree about Vite.
 *
 * CI builds and packages an example, so the examples are the configuration
 * that is actually known to work. The templates are the configuration users
 * get, and nothing builds those - which is how they came to sit two majors
 * behind on a `@vitejs/plugin-react` that requires Vite 8, so that a freshly
 * scaffolded React app would not `npm install` at all.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const templatesRoot = join(repoRoot, "packages", "create", "templates");
const examplesRoot = join(repoRoot, "examples");

async function manifests(root) {
  const entries = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory(),
  );
  return Promise.all(
    entries.map(async (entry) => ({
      name: entry.name,
      json: JSON.parse(
        await readFile(join(root, entry.name, "package.json"), "utf8"),
      ),
    })),
  );
}

const viteRange = (json) =>
  json.devDependencies?.vite ?? json.dependencies?.vite;

test("every template pins the same Vite range the examples build against", async () => {
  // Only the examples that actually use Vite. Not every one does - a
  // server-rendered example has a real HTTP server where the others have a
  // bundler - and an example with no opinion about Vite should not be read as
  // disagreeing with the ones that have.
  const examples = (await manifests(examplesRoot)).filter(({ json }) =>
    viteRange(json),
  );
  assert.ok(
    examples.length > 0,
    "no example builds against Vite, so there is nothing to hold the templates to",
  );

  const ranges = new Set(examples.map(({ json }) => viteRange(json)));
  assert.equal(
    ranges.size,
    1,
    `the examples disagree about Vite: ${[...ranges].join(", ")}`,
  );
  const [expected] = [...ranges];

  for (const { name, json } of await manifests(templatesRoot)) {
    assert.equal(
      viteRange(json),
      expected,
      `template ${name} is not on the tested Vite range`,
    );
  }
});

test("every template that uses a framework declares a build plugin for it", async () => {
  // A template whose vite.config imports a plugin it does not depend on fails
  // at the first `npm run dev`, well after the person has stopped reading.
  for (const { name, json } of await manifests(templatesRoot)) {
    const config = await readFile(
      join(templatesRoot, name, "vite.config.ts"),
      "utf8",
    ).catch(() => "");
    const declared = { ...json.dependencies, ...json.devDependencies };

    for (const [, specifier] of config.matchAll(
      /^import .* from "([^"]+)";$/gm,
    )) {
      if (specifier === "vite" || specifier.startsWith(".")) continue;
      assert.ok(
        specifier in declared,
        `${name}/vite.config.ts imports ${specifier}, which it does not depend on`,
      );
    }
  }
});
