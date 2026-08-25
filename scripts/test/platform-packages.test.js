/**
 * The distribution story, end to end.
 *
 * An application developer never compiles Rust because the binary arrives as
 * an npm package. This checks that the packages the release script produces
 * are actually the shape `@vantail/runtime` looks for - the one link in the
 * chain that only breaks after publishing, when it is expensive to fix.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = [];

after(async () => {
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

describe("platform packages", () => {
  let out;
  let platforms;

  before(async () => {
    platforms = JSON.parse(await readFile(join(root, "packages/runtime/platforms.json"), "utf8"));

    // A stand-in for every target, so the script is exercised for all five
    // rather than only the one this machine can build.
    const binaries = await temporary("vantail-binaries-");
    for (const target of platforms.targets) {
      const name = target.platform === "win32" ? "vantail-runtime.exe" : "vantail-runtime";
      await mkdir(join(binaries, target.rust), { recursive: true });
      await writeFile(join(binaries, target.rust, name), "#!/bin/sh\necho 0.1.0\n", "utf8");
      await chmod(join(binaries, target.rust, name), 0o755);
    }

    out = await temporary("vantail-packages-");
    execFileSync(
      process.execPath,
      [join(root, "scripts/build-platform-packages.mjs"), "--binaries", binaries, "--out", out, "--all"],
      { stdio: "pipe" },
    );
  });

  it("produces one package per published target", async () => {
    for (const target of platforms.targets) {
      const directory = join(out, target.package.replace("@vantail/", ""));
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      assert.equal(manifest.name, target.package);
      // npm reads these to install exactly one of the five.
      assert.deepEqual(manifest.os, [target.platform]);
      assert.deepEqual(manifest.cpu, [target.arch]);
    }
  });

  it("every package version matches the repository's", async () => {
    const expected = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
    for (const target of platforms.targets) {
      const manifest = JSON.parse(
        await readFile(join(out, target.package.replace("@vantail/", ""), "package.json"), "utf8"),
      );
      assert.equal(manifest.version, expected, `${target.package} is out of step`);
    }
  });

  it("names the Windows binary with an .exe", async () => {
    const windows = platforms.targets.filter((target) => target.platform === "win32");
    assert.ok(windows.length > 0);
    for (const target of windows) {
      const directory = join(out, target.package.replace("@vantail/", ""));
      await readFile(join(directory, "bin", "vantail-runtime.exe"));
    }
  });

  it("refuses to publish a half-built matrix", async () => {
    const partial = await temporary("vantail-partial-");
    await mkdir(join(partial, "aarch64-apple-darwin"), { recursive: true });
    await writeFile(join(partial, "aarch64-apple-darwin", "vantail-runtime"), "x", "utf8");

    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            join(root, "scripts/build-platform-packages.mjs"),
            "--binaries",
            partial,
            "--out",
            join(partial, "out"),
            "--all",
          ],
          { stdio: "pipe" },
        ),
      /Missing binaries/,
    );
  });

  it("is what @vantail/runtime actually looks for", async () => {
    // The point of the whole exercise: an installed platform package has to be
    // found by the resolver, from a project that is not this repository.
    const project = await temporary("vantail-consumer-");
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0" }),
      "utf8",
    );

    const modules = join(project, "node_modules", "@vantail");
    await mkdir(modules, { recursive: true });
    await cp(join(root, "packages/runtime"), join(modules, "runtime"), { recursive: true });
    await cp(join(out, "runtime-darwin-arm64"), join(modules, "runtime-darwin-arm64"), {
      recursive: true,
    });

    // A file:// URL, not a path: Windows rejects `C:\...` as an ESM specifier.
    const { resolveRuntimeBinary } = await import(
      pathToFileURL(join(modules, "runtime", "dist", "index.js")).href
    );
    const resolution = resolveRuntimeBinary({
      cwd: project,
      platform: "darwin",
      arch: "arm64",
    });

    // `package`, not `workspace` - proving it came from node_modules rather
    // than falling back to a local cargo build.
    assert.equal(resolution.source, "package");
    assert.equal(resolution.package, "@vantail/runtime-darwin-arm64");
    // Built with `join`, not a literal: the separator differs on Windows.
    assert.ok(resolution.path.endsWith(join("bin", "vantail-runtime")));
  });
});

describe("release workflow", () => {
  it("builds exactly the targets that get published", async () => {
    // Drift here is silent and expensive: a target missing from the matrix
    // means the release fails halfway through, after some packages are up.
    const { parse } = await import("yaml");
    const workflow = parse(await readFile(join(root, ".github/workflows/release.yml"), "utf8"));
    const platforms = JSON.parse(
      await readFile(join(root, "packages/runtime/platforms.json"), "utf8"),
    );

    const declared = platforms.targets.map((target) => target.rust).sort();
    const built = workflow.jobs.runtime.strategy.matrix.include
      .map((entry) => entry.target)
      .sort();

    assert.deepEqual(built, declared);
  });

  it("gives every target a runner of its own architecture", async () => {
    const { parse } = await import("yaml");
    const workflow = parse(await readFile(join(root, ".github/workflows/release.yml"), "utf8"));

    for (const entry of workflow.jobs.runtime.strategy.matrix.include) {
      // Native runners rather than cross-compilation: the runtime links
      // against the platform's webview, tray and HID libraries.
      const wantsArm = entry.target.startsWith("aarch64");
      const runnerIsArm = entry.runner.includes("arm") || entry.runner === "macos-14";
      assert.equal(
        runnerIsArm,
        wantsArm,
        `${entry.target} is built on ${entry.runner}, which is the wrong architecture`,
      );
    }
  });

  it("publishes dependencies before the packages that need them", async () => {
    const script = await readFile(join(root, "scripts/publish.mjs"), "utf8");
    const order = /const WORKSPACE_ORDER = \[([\s\S]*?)\]/.exec(script)[1];
    const packages = [...order.matchAll(/"packages\/([^"]+)"/g)].map((match) => match[1]);

    const position = (name) => packages.indexOf(name);
    // @vantail/cli depends on runtime, shared and vite; all of them have to
    // exist on the registry first or an install of the CLI breaks.
    assert.ok(position("shared") < position("api"));
    assert.ok(position("runtime") < position("cli"));
    assert.ok(position("shared") < position("cli"));
    assert.ok(position("vite") < position("cli"));
    assert.ok(position("cli") < position("create"));
  });

  it("publishes to npmjs through OIDC, holding no token at all", async () => {
    // Everything here fails at the last step of a release, after the five
    // native builds have already run, which is the most expensive place to
    // find out.
    const { parse } = await import("yaml");
    const workflow = parse(await readFile(join(root, ".github/workflows/release.yml"), "utf8"));
    const steps = workflow.jobs.publish.steps;

    const registry = steps.find((step) => step.run?.includes("@vantail:registry"));
    assert.ok(registry, "no step points the scope at a registry");
    assert.match(registry.run, /@vantail:registry=https:\/\/registry\.npmjs\.org/);

    // Provenance is signed with an OIDC token minted from this workflow.
    assert.equal(workflow.jobs.publish.permissions["id-token"], "write");

    const publish = steps.find((step) => step.run?.includes("publish.mjs"));
    assert.ok(publish, "nothing in the job publishes");
    // publish.mjs refuses npmjs without this, on purpose.
    assert.match(publish.run, /--i-mean-it-publish-publicly/);

    // Trusted publishing needs npm 11.5.1, and the Node this job sets up
    // still ships npm 10. Without the upgrade the OIDC exchange never
    // happens and the publish asks for a token that does not exist.
    assert.ok(
      steps.some((step) => /npm install -g npm@/.test(step.run ?? "")),
      "npm is not upgraded, so it is too old to publish with OIDC",
    );

    // An `_authToken` line takes precedence over the OIDC exchange, so the
    // registry config has to stay credential-free. This is also what keeps a
    // token from being reintroduced quietly later.
    assert.doesNotMatch(registry.run, /_authToken/);
    for (const step of steps) {
      assert.ok(
        !step.env?.NODE_AUTH_TOKEN && !/NPM_TOKEN/.test(JSON.stringify(step.env ?? {})),
        `${step.name} carries an npm token; trusted publishing does not use one`,
      );
    }
  });

  it("runs both channels from one file, because npm allows one publisher", async () => {
    // npm permits a package exactly one trusted publisher, bound to an exact
    // workflow filename. Splitting dev builds into a second file would mean
    // reintroducing a token for them, so both triggers have to live here.
    const { parse } = await import("yaml");
    const source = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
    const workflow = parse(source);

    // `on` is the YAML 1.1 boolean `true` unless quoted, which is why this
    // reads the key rather than the word.
    const on = workflow.on ?? workflow[true];
    assert.deepEqual(on.push.tags, ["v*"], "tagged releases are not triggered");
    assert.deepEqual(on.push.branches, ["main"], "pushes to main are not triggered");

    const steps = workflow.jobs.publish.steps;

    // A push to main must never move `latest`.
    const publish = steps.find((step) => step.run?.includes("publish.mjs"));
    assert.match(publish.run, /--tag dev/);
    assert.match(
      publish.run,
      /outputs\.channel \}\}" = "dev"/,
      "`--tag dev` is not guarded by the channel, so a release could ship as dev",
    );

    // The dev version is a prerelease of the next patch, set before the build
    // so the built artefacts carry it too.
    const bump = steps.find((step) => /version\.mjs dev/.test(step.run ?? ""));
    assert.ok(bump, "nothing sets a prerelease version for a dev build");
    assert.match(bump.if ?? "", /channel.*dev/);
    assert.ok(
      steps.indexOf(bump) < steps.findIndex((step) => step.run === "pnpm build"),
      "the version is bumped after the build, so the artefacts carry the old one",
    );

    // Five native builds on every push to main would cost more than they are
    // worth, so a dev build reuses the last release's binaries.
    assert.match(workflow.jobs.publish.if, /needs\.plan\.outputs\.ready == 'true'/);

    // A hand-started run is the only way to exercise the native builds
    // without cutting a tag, and it is what the first release is bootstrapped
    // from. Treated as a dev build it would skip itself, since a dev build
    // never builds runtimes.
    const decide = workflow.jobs.plan.steps.find((step) => step.id === "decide");
    assert.match(
      decide.run,
      /workflow_dispatch" \]; then\n\s*CHANNEL=release/,
      "a hand-started run does not take the release path, so it does nothing",
    );
  });
});
