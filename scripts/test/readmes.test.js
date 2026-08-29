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

/** Every value `@vantail/api` exports - the modules an application imports. */
async function publicApi() {
  const source = await readFile(join(root, "packages/api/src/index.ts"), "utf8");
  return [
    ...new Set(
      [...source.matchAll(/export \{([^}]*)\} from/gs)]
        .flatMap((match) => match[1].split(","))
        .map((name) => name.trim())
        // `export { type Foo }` is a type, not a module somebody imports.
        .filter((name) => name && !name.startsWith("type "))
        // `appWindow as window` is one API under two names.
        .map((name) => (name.includes(" as ") ? name.split(" as ")[1].trim() : name)),
    ),
  ];
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

describe("the api readme keeps up with the api", () => {
  it("names every module `@vantail/api` exports", async () => {
    // A README is the first thing anyone reads and the last thing anyone
    // updates. Shipping a capability that the package page does not mention
    // is the same as not shipping it for everyone who looks there first.
    const readme = await readFile(join(root, "packages/api/README.md"), "utf8");
    const api = await publicApi();

    // Helpers and error plumbing are documented in prose rather than in the
    // list of modules, which is what the list is for.
    const prose = new Set(["invoke", "listen", "isVantail", "runtimeVersion", "windowLabel", "VantailError", "ErrorCode"]);

    const missing = api
      .filter((name) => !prose.has(name))
      .filter((name) => !new RegExp(`\\b${name}\\b`).test(readme));

    assert.deepEqual(
      missing,
      [],
      `packages/api/README.md does not mention: ${missing.join(", ")}.\n` +
        "Add it to the list of what is in the package.",
    );
  });
});
