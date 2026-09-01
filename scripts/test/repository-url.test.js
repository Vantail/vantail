/**
 * Every file that names the repository names the same one.
 *
 * The URL lives in a Cargo manifest, nine package.json files, a generator
 * fallback and four template READMEs, in three spellings. Nothing in the build
 * reads any of them, so a rename can go through the whole tree and leave one
 * behind - which is what happened, and the stale field survived until somebody
 * happened to look at it. `scripts/version.mjs --check` does this job for the
 * version number; this does it for the URL.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `owner/repo` from any of the spellings in use: a plain URL, npm's
 * `git+https://...git`, and an SSH remote. Returns null for anything that is
 * not a GitHub repository URL, so callers can tell "absent" from "wrong".
 */
function slug(url) {
  if (typeof url !== "string") return null;
  const match = url
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/#?]+)/);
  return match ? match[1] : null;
}

/** The workspace `repository` field - the value everything else must match. */
async function canonical() {
  const manifest = await readFile(join(root, "Cargo.toml"), "utf8");
  const match = manifest.match(/^repository\s*=\s*"([^"]+)"/m);
  assert.ok(match, "Cargo.toml declares no repository");

  const owner = slug(match[1]);
  assert.ok(owner, `Cargo.toml's repository is not a GitHub URL: ${match[1]}`);
  return owner;
}

/** Every committed package.json, root workspace included. */
async function manifests() {
  const dir = join(root, "packages");
  const names = await readdir(dir);
  const paths = [join(root, "package.json"), ...names.map((n) => join(dir, n, "package.json"))];

  return Promise.all(
    paths.map(async (path) => ({
      path: relative(root, path),
      manifest: JSON.parse(await readFile(path, "utf8")),
    })),
  );
}

describe("repository url", () => {
  it("agrees between Cargo.toml and every package.json", async () => {
    const expected = await canonical();
    const wrong = [];

    for (const { path, manifest } of await manifests()) {
      const found = slug(manifest.repository?.url);
      assert.ok(found, `${path} has no GitHub repository.url`);
      if (found !== expected) wrong.push(`${path} says ${found}`);
    }

    assert.deepEqual(
      wrong,
      [],
      `Cargo.toml says ${expected}, but ${wrong.join(", ")}.\n` +
        "Every manifest names one repository.",
    );
  });

  it("agrees with the homepage each package.json points at", async () => {
    const expected = await canonical();
    const wrong = [];

    for (const { path, manifest } of await manifests()) {
      // `homepage` is optional, but a wrong one is worse than a missing one.
      if (manifest.homepage === undefined) continue;
      const found = slug(manifest.homepage);
      if (found !== expected) wrong.push(`${path} says ${manifest.homepage}`);
    }

    assert.deepEqual(wrong, [], `homepage should be ${expected}, but ${wrong.join(", ")}`);
  });

  it("agrees with the git remote", async () => {
    // The remote is the one value nobody has to remember to update, so it is
    // the tiebreaker when the manifests and reality disagree.
    const config = await readFile(join(root, ".git/config"), "utf8");
    const match = config.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
    if (!match) return; // a worktree or a fresh clone with no origin

    const found = slug(match[1]);
    if (!found) return; // a fork on some other host is not this test's business

    assert.equal(found, await canonical(), "Cargo.toml does not name origin");
  });

  it("agrees with the fallback the platform package generator ships", async () => {
    // Platform packages are built at release time from a manifest that may not
    // carry a repository, and the generator hardcodes a URL for that case.
    const source = await readFile(join(root, "scripts/build-platform-packages.mjs"), "utf8");
    const expected = await canonical();

    for (const [, url] of source.matchAll(/"(https:\/\/github\.com\/[^"]+)"/g)) {
      assert.equal(slug(url), expected, `the generator hardcodes ${url}`);
    }
  });

  it("agrees with the templates every new project is scaffolded from", async () => {
    // These get copied into somebody else's repository, where a dead link is
    // ours to have shipped and theirs to trip over.
    const dir = join(root, "packages/create/templates");
    const expected = await canonical();
    const wrong = [];

    for (const name of await readdir(dir)) {
      const path = join(dir, name, "README.md");
      const readme = await readFile(path, "utf8").catch(() => null);
      if (readme === null) continue;

      for (const [, url] of readme.matchAll(/(https:\/\/github\.com\/\S+?)[\s).,]/g)) {
        if (slug(url) !== expected) wrong.push(`${relative(root, path)} links to ${url}`);
      }
    }

    assert.deepEqual(wrong, [], `should link to ${expected}, but ${wrong.join(", ")}`);
  });
});
