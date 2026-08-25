/**
 * Where a packaged application lands.
 *
 * It used to go in `.vantail`, alongside Vantail's own working files. Finder
 * hides dot-directories, so the one folder a person most wants to open - the
 * one holding the .app they are meant to double-click - was invisible unless
 * they knew Cmd-Shift-period.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A file URL, not a path: `scripts/` is not a workspace package, so the bare
// specifier does not resolve, and Windows rejects a bare absolute path.
const { DEFAULT_OUT_DIR, INTERNAL_DIR } = await import(
  pathToFileURL(join(repoRoot, "packages", "shared", "dist", "config.js")).href
);
const templatesRoot = join(repoRoot, "packages", "create", "templates");

test("the packaged application goes somewhere Finder shows", () => {
  assert.ok(
    !DEFAULT_OUT_DIR.startsWith("."),
    `${DEFAULT_OUT_DIR} is hidden - the point of this directory is that it is not`,
  );
});

test("Vantail's own working files stay out of sight", () => {
  // The updater's signing key lives here. It should not be somewhere a person
  // browses, and it must never be somewhere they commit.
  assert.ok(INTERNAL_DIR.startsWith("."));
});

test("every template ignores both of them", async () => {
  const templates = (await readdir(templatesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  assert.ok(templates.length > 0);

  for (const template of templates) {
    const ignored = await readFile(
      join(templatesRoot, template, "_gitignore"),
      "utf8",
    );
    const lines = ignored.split("\n").map((line) => line.trim());

    for (const directory of [DEFAULT_OUT_DIR, INTERNAL_DIR]) {
      assert.ok(
        lines.includes(`${directory}/`) || lines.includes(directory),
        `${template} does not ignore ${directory}`,
      );
    }
  }
});
