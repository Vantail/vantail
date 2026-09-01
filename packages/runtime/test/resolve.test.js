/**
 * Which local build gets picked.
 *
 * This is not a detail: a debug runtime is roughly ten times the size of a
 * release one, and packaging with the wrong one produces a 28 MB application
 * that looks exactly like a correct 3 MB one until somebody checks.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  isSupportedPlatform,
  resolveRuntimeBinary,
  runtimeBinaryName,
  runtimePackageName,
  supportedPlatformNames,
  supportedTargets,
  UnsupportedPlatformError,
} from "../dist/index.js";

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

  it("uses the local build whatever variant is asked for", async () => {
    // Inside a checkout there is one binary and it is whatever you last
    // compiled. Pretending otherwise would mean `vantail dev` refusing to run
    // against a runtime sitting right there.
    //
    // Built here rather than leaning on this repository's own `target/`: on a
    // CI runner that has not compiled the runtime yet, that directory is
    // empty, and a test that needs it is testing the machine.
    const checkout = await mkdtemp(join(tmpdir(), "vantail-variant-"));
    scratch.push(checkout);
    await mkdir(join(checkout, "runtime"), { recursive: true });
    await writeFile(join(checkout, "runtime", "Cargo.toml"), "[package]\n", "utf8");
    await mkdir(join(checkout, "target", "release"), { recursive: true });
    await writeFile(
      join(checkout, "target", "release", runtimeBinaryName("linux")),
      "release",
      "utf8",
    );

    delete process.env.VANTAIL_RUNTIME_BIN;
    const resolved = resolveRuntimeBinary({
      cwd: checkout,
      platform: "linux",
      arch: "x64",
      variant: "sqlcipher",
    });
    assert.equal(resolved.source, "workspace");
    assert.equal(resolved.profile, "release");
  });
});

/**
 * Refusing a platform by name.
 *
 * `runtimePackageName` will happily build `@vantail/runtime-freebsd-x64`,
 * because it is string concatenation. Nothing publishes that package, so the
 * install command the old error printed returned a 404 - a confidently wrong
 * answer, which is worse than no answer. These drive the resolver with
 * injected values, so none of it needs the hardware.
 */
describe("unsupported platforms", () => {
  before(() => {
    // An override short-circuits the check on purpose, so it has to be gone.
    delete process.env.VANTAIL_RUNTIME_BIN;
  });

  it("refuses an Intel Mac rather than naming a package that does not exist", () => {
    assert.throws(
      () => resolveRuntimeBinary({ platform: "darwin", arch: "x64" }),
      (error) => {
        assert.ok(
          error instanceof UnsupportedPlatformError,
          `threw ${error.name}, not UnsupportedPlatformError`,
        );
        assert.match(error.message, /darwin-x64/);
        return true;
      },
    );
  });

  it("refuses a platform nothing is built for at all", () => {
    assert.throws(
      () => resolveRuntimeBinary({ platform: "freebsd", arch: "x64" }),
      UnsupportedPlatformError,
    );
  });

  it("says which platforms do exist, so the message ends somewhere", () => {
    // The failure this replaces was an install command that 404s. A refusal
    // that does not say what would work is barely an improvement.
    try {
      resolveRuntimeBinary({ platform: "darwin", arch: "x64" });
      assert.fail("resolved a platform that is not published");
    } catch (error) {
      assert.ok(error.supported.length > 0, "listed no supported platforms");
      assert.match(error.message, /darwin-arm64/);
      for (const name of error.supported) {
        assert.match(error.message, new RegExp(name.replace(/[-]/g, "\\$&")));
      }
    }
  });

  it("takes the list from platforms.json rather than a copy of it", () => {
    // The point of reading the file: publishing a new target is a row there
    // and nothing else. A hand-written list here would pass while the real
    // one drifted.
    const platforms = JSON.parse(
      readFileSync(new URL("../platforms.json", import.meta.url), "utf8"),
    );

    assert.deepEqual(
      supportedPlatformNames(),
      platforms.targets.map((target) => `${target.platform}-${target.arch}`),
    );
    assert.deepEqual(supportedTargets(), platforms.targets);
  });

  it("still resolves the platforms that are published", async () => {
    // The regression that would matter most: refusing everybody.
    for (const target of supportedTargets()) {
      assert.ok(
        isSupportedPlatform(target.platform, target.arch),
        `${target.platform}-${target.arch} is in platforms.json but rejected`,
      );
    }

    // And that the resolver agrees with the predicate, for every one of them.
    //
    // Built here rather than leaning on this repository's own `target/`, for
    // two reasons that both bite on CI: a runner that has not compiled the
    // runtime has nothing there at all, and the binary is named for the
    // platform - a Windows runner produces `vantail-runtime.exe`, so asking
    // it about darwin finds nothing. A test that needs either is testing the
    // machine.
    const checkout = await mkdtemp(join(tmpdir(), "vantail-supported-"));
    scratch.push(checkout);
    await mkdir(join(checkout, "runtime"), { recursive: true });
    await writeFile(join(checkout, "runtime", "Cargo.toml"), "[package]\n", "utf8");
    await mkdir(join(checkout, "target", "release"), { recursive: true });

    // Both spellings, so one workspace answers for every target.
    for (const name of new Set(supportedTargets().map((t) => runtimeBinaryName(t.platform)))) {
      await writeFile(join(checkout, "target", "release", name), "release", "utf8");
    }

    for (const target of supportedTargets()) {
      const resolved = resolveRuntimeBinary({
        cwd: checkout,
        platform: target.platform,
        arch: target.arch,
      });
      assert.ok(
        resolved.path,
        `${target.platform}-${target.arch} is published but did not resolve`,
      );
    }
  });

  it("lets an explicit binary through on any platform", async () => {
    // Somebody who compiled the runtime for a platform we do not publish is
    // not asking permission, and the resolver should not second-guess them.
    //
    // Its own directory rather than one an earlier suite happened to create:
    // borrowing `scratch[0]` made this pass only while the suites ran in the
    // order they are written.
    const home = await mkdtemp(join(tmpdir(), "vantail-override-"));
    scratch.push(home);
    const override = join(home, "vantail-runtime");
    writeFileSync(override, "binary");
    process.env.VANTAIL_RUNTIME_BIN = override;
    try {
      const resolved = resolveRuntimeBinary({ platform: "freebsd", arch: "x64" });
      assert.equal(resolved.source, "env");
    } finally {
      delete process.env.VANTAIL_RUNTIME_BIN;
    }
  });
});
