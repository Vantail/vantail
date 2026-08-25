/**
 * Deciding whether the native runtime really moved.
 *
 * This exists because the obvious check was wrong in a way nobody noticed for
 * two releases: `version.mjs` bumps the crate version, so "did Cargo.toml
 * change" is true on every single release. That rebuilt five runtimes each
 * time, and made every dev build after a release skip itself.
 *
 * The repository's own history is not used here - a shallow clone would have
 * none - so each case builds the history it needs.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "runtime-changed.mjs",
);

let repo;

function git(...args) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function commit(message) {
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message);
}

/** What the script says, run inside the scratch repository. */
function changedSince(base) {
  return execFileSync(process.execPath, [script, "--base", base, "--repo", repo], {
    encoding: "utf8",
  }).trim();
}

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "runtime-changed-"));
  await mkdir(join(repo, "runtime", "src"), { recursive: true });
  await writeFile(join(repo, "runtime", "src", "main.rs"), "fn main() {}\n");
  await writeFile(join(repo, "runtime", "Cargo.toml"), '[package]\nname = "r"\n');
  await writeFile(join(repo, "Cargo.toml"), '[workspace.package]\nversion = "0.1.0"\n');
  await writeFile(join(repo, "Cargo.lock"), 'name = "r"\nversion = "0.1.0"\n');

  git("init", "-q", "-b", "main");
  // A global gitignore that excludes Cargo.lock is a common setting, and it
  // would silently keep the file out of every commit here. The scratch repo
  // has to answer for itself.
  git("config", "core.excludesFile", "/dev/null");
  commit("start");
  git("tag", "v0.1.0");
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

describe("runtime-changed", () => {
  it("a version bump alone is not a change", async () => {
    // Exactly what `version.mjs` does at release time.
    await writeFile(join(repo, "Cargo.toml"), '[workspace.package]\nversion = "0.1.1"\n');
    await writeFile(join(repo, "Cargo.lock"), 'name = "r"\nversion = "0.1.1"\n');
    commit("Release 0.1.1");

    assert.equal(changedSince("v0.1.0"), "false");
  });

  it("a change to the Rust is", async () => {
    await appendFile(join(repo, "runtime", "src", "main.rs"), "// new\n");
    commit("touch the runtime");

    assert.equal(changedSince("v0.1.0"), "true");
  });

  it("so is a dependency moving in the lockfile alone", async () => {
    // `cargo update` touches nothing else, and does change the binary.
    git("tag", "v0.1.1");
    await writeFile(
      join(repo, "Cargo.lock"),
      'name = "r"\nversion = "0.1.1"\nname = "serde"\nversion = "1.0.2"\n',
    );
    commit("cargo update");

    assert.equal(changedSince("v0.1.1"), "true");
  });

  it("rebuilds rather than guesses when the ref is unknown", () => {
    // Shipping the wrong binaries is worse than a slow release.
    assert.equal(changedSince("v9.9.9"), "true");
  });
});
