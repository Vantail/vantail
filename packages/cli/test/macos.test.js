/**
 * The macOS bundle carries the TCC usage descriptions macOS requires before
 * it will show a privacy prompt. Without the matching `NS*UsageDescription`,
 * capture is denied without ever asking - so the config strings must arrive
 * in `Info.plist` verbatim, and absent config must leave the keys out.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { writeMacBundle } from "../dist/bundle/macos.js";

const roots = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function input(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "vantail-macos-"));
  roots.push(root);
  const distDir = join(root, "dist");
  const runtimePath = join(root, "runtime");
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, "index.html"), "<!doctype html>", "utf8");
  await writeFile(runtimePath, "fake-runtime", "utf8");
  const outDir = join(root, "out");
  await mkdir(outDir, { recursive: true });

  return {
    config: {
      app: { name: "My App", identifier: "dev.vantail.test", version: "0.1.0" },
      ...overrides,
    },
    root,
    distDir,
    runtimePath,
    outDir,
    platform: "darwin",
  };
}

async function plist(config) {
  const args = await input(config);
  const { path } = await writeMacBundle(args);
  return readFile(join(path, "Contents", "Info.plist"), "utf8");
}

test("usage descriptions arrive in Info.plist", async () => {
  const text = await plist({
    macos: {
      microphoneUsageDescription: "Voice notes are recorded on your request.",
      cameraUsageDescription: "Video calls show your camera.",
    },
  });
  assert.ok(text.includes("<key>NSMicrophoneUsageDescription</key>"));
  assert.ok(text.includes("Voice notes are recorded on your request."));
  assert.ok(text.includes("<key>NSCameraUsageDescription</key>"));
  assert.ok(text.includes("Video calls show your camera."));
});

test("missing descriptions leave the keys out", async () => {
  const text = await plist({});
  assert.ok(!text.includes("NSMicrophoneUsageDescription"));
  assert.ok(!text.includes("NSCameraUsageDescription"));
});

test("descriptions are XML-escaped", async () => {
  const text = await plist({
    macos: { microphoneUsageDescription: "Fish & Chips <mic>" },
  });
  assert.ok(text.includes("Fish &amp; Chips &lt;mic&gt;"));
});
