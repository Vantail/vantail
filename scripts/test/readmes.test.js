/**
 * Every published package needs a README.
 *
 * npm shows one on the package page, and without a file it prints
 * "ERROR: No README data found!" to everyone who looks. That is not something
 * a test run would otherwise notice, because nothing in the build depends on
 * it, and it is only visible once the package is already public.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function packages() {
  const dir = join(root, "packages");
  const names = await readdir(dir);
  return Promise.all(
    names.map(async (name) => ({
      name,
      dir: join(dir, name),
      manifest: JSON.parse(await readFile(join(dir, name, "package.json"), "utf8")),
    })),
  );
}

describe("package readmes", () => {
  it("exists for every package that gets published", async () => {
    const missing = [];
    for (const pkg of await packages()) {
      if (pkg.manifest.private) continue;
      if (!existsSync(join(pkg.dir, "README.md"))) missing.push(pkg.manifest.name);
    }

    assert.deepEqual(missing, [], `no README.md in: ${missing.join(", ")}`);
  });

  it("says what the package is, not just its name", async () => {
    for (const pkg of await packages()) {
      if (pkg.manifest.private) continue;
      const readme = await readFile(join(pkg.dir, "README.md"), "utf8");

      // A stub is worse than useless: it looks deliberate.
      assert.ok(
        readme.length > 200,
        `${pkg.manifest.name}'s README is ${readme.length} characters, which is a stub`,
      );
      assert.match(
        readme,
        new RegExp(`^# ${pkg.manifest.name.replace(/[/@-]/g, "\\$&")}`, "m"),
        `${pkg.manifest.name}'s README does not start with the package name`,
      );
    }
  });

  it("has no unrendered template values", async () => {
    // `repository` is an object, so interpolating it into a string produces
    // "[object Object]" - which is exactly what shipped once.
    const suspects = [/\[object Object\]/, /\bundefined\b/, /\$\{/];

    for (const pkg of await packages()) {
      if (pkg.manifest.private) continue;
      const readme = await readFile(join(pkg.dir, "README.md"), "utf8");
      for (const pattern of suspects) {
        assert.doesNotMatch(
          readme,
          pattern,
          `${pkg.manifest.name}'s README contains ${pattern}`,
        );
      }
    }
  });

  it("is generated for the platform packages too", async () => {
    // Those are built at release time rather than committed, so this checks
    // the generator instead of an artefact.
    const source = await readFile(
      join(root, "scripts/build-platform-packages.mjs"),
      "utf8",
    );

    assert.match(source, /README\.md/, "the generator writes no README");
    assert.doesNotMatch(
      source,
      /\$\{manifest\.repository\}/,
      "the generator interpolates the repository object, which renders as [object Object]",
    );
  });
});
