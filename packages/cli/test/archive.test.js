/**
 * The tar writer is only useful if something else can read what it produces -
 * the runtime unpacks these with Rust's `tar` crate, and the system `tar` is
 * the closest independent reader available here.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { after, test } from "node:test";

import { tarGzip } from "../dist/bundle/archive.js";

const roots = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "vantail-tar-"));
  roots.push(root);
  return root;
}

/** A bundle shaped like the ones `vantail package` produces. */
async function sampleBundle(name = "My App.app") {
  const root = await scratch();
  const bundle = join(root, name);
  await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(bundle, "Contents", "Resources", "dist", "assets"), { recursive: true });

  await writeFile(join(bundle, "Contents", "Info.plist"), "<plist/>", "utf8");
  await writeFile(join(bundle, "Contents", "MacOS", "My-App"), "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(join(bundle, "Contents", "MacOS", "My-App"), 0o755);
  await writeFile(join(bundle, "Contents", "Resources", "vantail.json"), "{}", "utf8");
  await writeFile(
    join(bundle, "Contents", "Resources", "dist", "assets", "index-abc123.js"),
    "export const x = 1;\n",
    "utf8",
  );

  return { root, bundle };
}

function haveTar() {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("produces a gzip stream", async () => {
  const { bundle } = await sampleBundle();
  const archive = await tarGzip(bundle);

  assert.equal(archive[0], 0x1f);
  assert.equal(archive[1], 0x8b);
  // Two 512-byte zero blocks end every tar.
  const tar = gunzipSync(archive);
  assert.equal(tar.length % 512, 0);
  assert.ok(tar.subarray(-1024).every((byte) => byte === 0));
});

test("everything hangs off a single top-level entry", async () => {
  // The runtime relies on this: whatever the one entry is, that is the app.
  const { bundle } = await sampleBundle();
  const tar = gunzipSync(await tarGzip(bundle));

  const names = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (name === "") break;
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, ""), 8) || 0;
    names.push(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  const tops = new Set(names.map((name) => name.split("/")[0]));
  assert.deepEqual([...tops], ["My App.app"]);
});

test("system tar reads it back, executable bit and all", { skip: !haveTar() }, async () => {
  const { bundle } = await sampleBundle();
  const out = await scratch();
  const archivePath = join(out, "bundle.tar.gz");
  await writeFile(archivePath, await tarGzip(bundle));

  const extracted = join(out, "extracted");
  await mkdir(extracted, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", extracted]);

  const executable = join(extracted, "My App.app", "Contents", "MacOS", "My-App");
  if (process.platform !== "win32") {
    // Windows has no POSIX mode bits for the archive to have preserved.
    assert.equal(statSync(executable).mode & 0o111, 0o111, "the exec bit did not survive");
  }
  assert.equal(
    await readFile(join(extracted, "My App.app", "Contents", "Info.plist"), "utf8"),
    "<plist/>",
  );
  assert.equal(
    await readFile(
      join(extracted, "My App.app", "Contents", "Resources", "dist", "assets", "index-abc123.js"),
      "utf8",
    ),
    "export const x = 1;\n",
  );
});

test("paths longer than a tar name field still round-trip", { skip: !haveTar() }, async () => {
  const { root, bundle } = await sampleBundle();
  // Deep enough to exceed the 100-byte name field and force a prefix split.
  const deep = join(bundle, "Contents", "Resources", "dist", ...Array(12).fill("nested-directory"));
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, "buried.txt"), "found me", "utf8");

  const archivePath = join(root, "deep.tar.gz");
  await writeFile(archivePath, await tarGzip(bundle));

  const extracted = join(root, "extracted");
  await mkdir(extracted, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", extracted]);

  const buried = join(
    extracted,
    "My App.app",
    "Contents",
    "Resources",
    "dist",
    ...Array(12).fill("nested-directory"),
    "buried.txt",
  );
  assert.equal(await readFile(buried, "utf8"), "found me");
});

test("the same tree produces the same bytes", async () => {
  // Directory order varies between reads; a release archive should not.
  const { bundle } = await sampleBundle();
  const first = await tarGzip(bundle);
  const second = await tarGzip(bundle);
  assert.deepEqual(first, second);
});
