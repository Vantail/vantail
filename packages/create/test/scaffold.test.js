/**
 * The scaffolder, run the way a person runs it.
 *
 * Everything else here checks the templates as files. This checks the one
 * thing only the CLI does: turning a template into a project someone can
 * actually `npm install`.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const run = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");
const scaffolder = join(packageRoot, "dist", "index.js");

describe(
  "scaffolding a project",
  { skip: existsSync(scaffolder) ? false : "not built" },
  () => {
    let root;

    const create = async (name, ...args) => {
      const target = join(root, name);
      await run("node", [
        scaffolder,
        target,
        "--name",
        "Test App",
        "--yes",
        ...args,
      ]);
      return target;
    };

    const manifest = async (target) =>
      JSON.parse(await readFile(join(target, "package.json"), "utf8"));

    before(async () => {
      root = await mkdtemp(join(tmpdir(), "vantail-scaffold-"));
    });

    after(async () => {
      if (root)
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 250,
        });
    });

    it("fills in the name and renames the gitignore", async () => {
      const target = await create("named", "--template", "vanilla-ts");

      assert.equal((await manifest(target)).name, "test-app");
      // npm refuses to publish a file called `.gitignore`, so it ships under a
      // placeholder that has to be put back.
      assert.ok(existsSync(join(target, ".gitignore")));
      assert.ok(!existsSync(join(target, "_gitignore")));

      const config = await readFile(join(target, "vantail.config.ts"), "utf8");
      assert.match(config, /name: "Test App"/);
      assert.ok(!config.includes("__APP_NAME__"));
    });

    it("scaffolds every template it offers", async () => {
      for (const template of [
        "react-ts",
        "svelte-ts",
        "vue-ts",
        "vanilla-ts",
      ]) {
        const target = await create(template, "--template", template);
        assert.ok(
          existsSync(join(target, "index.html")),
          `${template} has no index.html`,
        );
        assert.ok(
          existsSync(join(target, "icon.png")),
          `${template} has no icon`,
        );
      }
    });

    it("points the Vantail packages at the checkout it ran from", async () => {
      // Nothing is published yet, so the version ranges in the templates cannot
      // resolve. Run from a checkout, the only installable answer is a link
      // back to it - and that is also what lets the runtime resolver find the
      // local `cargo build`.
      const { dependencies, devDependencies } = await manifest(
        await create("linked", "--template", "react-ts"),
      );

      assert.equal(
        dependencies["@vantail/api"],
        `file:${join(repoRoot, "packages", "api")}`,
      );
      assert.equal(
        devDependencies["@vantail/cli"],
        `file:${join(repoRoot, "packages", "cli")}`,
      );
      // Everything else keeps its published range.
      assert.match(devDependencies.vite, /^\^\d/);
    });

    it("leaves the published ranges alone when told not to link", async () => {
      const { dependencies } = await manifest(
        await create("unlinked", "--template", "react-ts", "--no-link"),
      );
      assert.match(dependencies["@vantail/api"], /^\^\d/);
    });
  },
);
