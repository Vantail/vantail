/**
 * Which local build gets picked.
 *
 * This is not a detail: a debug runtime is roughly ten times the size of a
 * release one, and packaging with the wrong one produces a 28 MB application
 * that looks exactly like a correct 3 MB one until somebody checks.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { resolveRuntimeBinary, runtimePackageName } from "../dist/index.js";

const scratch = [];
after(async () => {
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});

describe("workspace fallback", () => {
  let workspace;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "vantail-workspace-"));
    scratch.push(workspace);

    // What the resolver walks up looking for.
    await mkdir(join(workspace, "runtime"), { recursive: true });
    await writeFile(join(workspace, "runtime", "Cargo.toml"), "[package]\n", "utf8");

    for (const profile of ["release", "debug"]) {
      await mkdir(join(workspace, "target", profile), { recursive: true });
      await writeFile(join(workspace, "target", profile, "vantail-runtime"), profile, "utf8");
    }

    // Debug built after release, which is the normal state of a machine
    // somebody is working on.
    const older = new Date(Date.now() - 60_000);
    await utimes(join(workspace, "target", "release", "vantail-runtime"), older, older);

    delete process.env.VANTAIL_RUNTIME_BIN;
  });

  it("takes the newest by default, so a fresh cargo build is what runs", () => {
    const resolved = resolveRuntimeBinary({
      cwd: workspace,
      platform: "darwin",
      arch: "arm64",
    });
    assert.equal(resolved.source, "workspace");
    assert.equal(resolved.profile, "debug");
  });

  it("takes release when asked, however stale it is", () => {
    // What `vantail package` asks for. Shipping a debug build by accident is
    // much easier than noticing it afterwards.
    const resolved = resolveRuntimeBinary({
      cwd: workspace,
      platform: "darwin",
      arch: "arm64",
      prefer: "release",
    });
    assert.equal(resolved.profile, "release");
  });

  it("falls back to debug when there is no release build", async () => {
    const debugOnly = await mkdtemp(join(tmpdir(), "vantail-debug-only-"));
    scratch.push(debugOnly);
    await mkdir(join(debugOnly, "runtime"), { recursive: true });
    await writeFile(join(debugOnly, "runtime", "Cargo.toml"), "[package]\n", "utf8");
    await mkdir(join(debugOnly, "target", "debug"), { recursive: true });
    await writeFile(join(debugOnly, "target", "debug", "vantail-runtime"), "x", "utf8");

    // Reported honestly rather than refused here - `vantail package` is what
    // decides that a debug build is not good enough to ship.
    const resolved = resolveRuntimeBinary({
      cwd: debugOnly,
      platform: "darwin",
      arch: "arm64",
      prefer: "release",
    });
    assert.equal(resolved.profile, "debug");
  });

  it("an explicit override still wins over everything", () => {
    const override = join(workspace, "target", "release", "vantail-runtime");
    process.env.VANTAIL_RUNTIME_BIN = override;
    try {
      const resolved = resolveRuntimeBinary({ cwd: workspace, platform: "darwin", arch: "arm64" });
      assert.equal(resolved.source, "env");
      assert.equal(resolved.path, override);
    } finally {
      delete process.env.VANTAIL_RUNTIME_BIN;
    }
  });
});

describe("runtime variants", () => {
  it("names the default build without a suffix", () => {
    // The name every existing application already depends on.
    assert.equal(
      runtimePackageName("darwin", "arm64"),
      "@vantail/runtime-darwin-arm64",
    );
    assert.equal(
      runtimePackageName("darwin", "arm64", "default"),
      "@vantail/runtime-darwin-arm64",
    );
  });

  it("names the encrypted build as its own package", () => {
    // A separate package rather than a flag, because it is a different
    // binary: SQLCipher is about 3 MB of crypto that most applications should
    // not be carrying.
    assert.equal(
      runtimePackageName("darwin", "arm64", "sqlcipher"),
      "@vantail/runtime-darwin-arm64-sqlcipher",
    );
    assert.equal(
      runtimePackageName("win32", "x64", "sqlcipher"),
      "@vantail/runtime-win32-x64-sqlcipher",
    );
  });

  it("names the variant's package when there is none installed", () => {
    // The lookup cannot be made to fail from inside this repository - the
    // workspace fallback deliberately finds the local `cargo build` - so what
    // is worth pinning is the name it would tell you to install, which is not
    // the same package as everyone else's.
    assert.equal(
      runtimePackageName(process.platform, process.arch, "sqlcipher"),
      `@vantail/runtime-${process.platform}-${process.arch}-sqlcipher`,
    );
  });

  it("uses the local build whatever variant is asked for", () => {
    // Inside this repository there is one binary and it is whatever you last
    // compiled. Pretending otherwise would mean `vantail dev` refusing to run
    // against a runtime that is sitting right there.
    delete process.env.VANTAIL_RUNTIME_BIN;
    // Any directory: the fallback also searches from the module's own
    // location, which is inside this repository.
    const resolved = resolveRuntimeBinary({
      cwd: tmpdir(),
      platform: process.platform,
      arch: process.arch,
      variant: "sqlcipher",
    });
    assert.equal(resolved.source, "workspace");
  });
});
