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
import { fileURLToPath, pathToFileURL } from "node:url";
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

describe("the root readme keeps up with the api", () => {
  /**
   * The modules `@vantail/api` exports, by name, as the built package has
   * them - so their methods can be checked as well as their names.
   *
   * A module is an exported object. `ErrorCode` is one too, but it is a table
   * of strings rather than something to call. `window` is `appWindow` under a
   * second name; namespace keys come sorted, so the first name wins.
   */
  async function modules() {
    const api = await import(
      pathToFileURL(join(root, "packages/api/dist/index.js")).href
    );
    const seen = new Set();
    const found = new Map();
    for (const [name, value] of Object.entries(api)) {
      if (!value || typeof value !== "object" || name === "ErrorCode") continue;
      if (seen.has(value)) continue;
      seen.add(value);
      found.set(name, value);
    }
    return { api, found };
  }

  /**
   * The `## The API` block, as module -> the names its row lists.
   *
   * A row is a module name at the start of a line, continued by indented
   * lines. `child: write | kill` lists what a returned object has rather than
   * the module, so that segment - and anything indented under it - is left
   * out.
   */
  async function listed() {
    // A Windows checkout has CRLF line endings; nothing here should care.
    const readme = (await readFile(join(root, "README.md"), "utf8")).replace(/\r\n/g, "\n");
    const section = readme.split(/^## The API$/m)[1];
    assert.ok(section, "README.md has no `## The API` section");
    const block = section.match(/```text\n([\s\S]*?)```/)?.[1];
    assert.ok(block, "the API section has no ```text block");

    const rows = new Map();
    let current;
    let nestedAt;
    for (const line of block.split("\n")) {
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      let content = line.trim();
      if (indent === 0) {
        const [, name, rest] = content.match(/^(\w+)\s+(.*)$/);
        current = name;
        rows.set(current, []);
        content = rest;
        nestedAt = undefined;
      }
      if (/^\w+:/.test(content)) {
        nestedAt = indent;
        continue;
      }
      if (nestedAt !== undefined && indent > nestedAt) continue;
      nestedAt = undefined;
      rows.get(current).push(
        ...content
          .split("|")
          .map((name) => name.trim())
          .filter(Boolean),
      );
    }
    return rows;
  }

  it("has a row for every module", async () => {
    // Nine modules shipped without one, and nothing noticed: the README is
    // the first thing anyone reads, so a module missing from it is a module
    // nobody finds.
    const { found } = await modules();
    const rows = await listed();

    const missing = [...found.keys()].filter((name) => !rows.has(name));

    assert.deepEqual(
      missing,
      [],
      `README.md's API list has no row for: ${missing.join(", ")}.\n` +
        "Add one under `## The API`, with the module's main methods.",
    );
  });

  it("lists only modules and methods that exist", async () => {
    // The other direction: a method renamed or removed in the SDK, still
    // advertised here. A row may also name top-level exports that belong
    // with it - `createWindow` sits with `appWindow`.
    const { api, found } = await modules();
    const rows = await listed();

    const phantom = [];
    for (const [module, names] of rows) {
      if (!found.has(module)) {
        phantom.push(module);
        continue;
      }
      for (const name of names) {
        if (!(name in found.get(module)) && !(name in api)) {
          phantom.push(`${module}.${name}`);
        }
      }
    }

    assert.deepEqual(
      phantom,
      [],
      `README.md's API list names what @vantail/api does not have: ${phantom.join(", ")}`,
    );
  });
});

describe("the api reference keeps up with the api", () => {
  /**
   * The docs compress siblings into one row: `onWindowCreated/Ready/Closed`
   * documents three functions. Expand those before looking, or the check
   * reports drift that is not there - which is exactly what a first draft of
   * this test did.
   */
  function expandSiblings(markdown) {
    return markdown.replace(
      /\b([A-Za-z]+)([A-Z][A-Za-z]*)((?:\/[A-Z][A-Za-z]*)+)/g,
      (_, stem, first, rest) =>
        [stem + first, ...rest.slice(1).split("/").map((part) => stem + part)].join(" "),
    );
  }

  it("names every value `@vantail/api` exports", async () => {
    // `packages/api/README.md` is already checked above. This is the other
    // half: docs/api.md is where the README sends people for the detail, and
    // nothing until now noticed when something shipped without arriving here.
    const doc = expandSiblings(await readFile(join(root, "docs/api.md"), "utf8"));

    // Documented as behaviour rather than by name: the error codes have their
    // own table and every example matches on the string, so an application
    // never writes `ErrorCode` even though the package exports it.
    const byBehaviour = new Set(["ErrorCode"]);

    const missing = (await publicApi())
      .filter((name) => !byBehaviour.has(name))
      .filter((name) => !new RegExp(`\\b${name}\\b`).test(doc));

    assert.deepEqual(
      missing,
      [],
      `docs/api.md does not mention: ${missing.join(", ")}.\n` +
        "Document it, or add it to `byBehaviour` if it is covered another way.",
    );
  });
});
