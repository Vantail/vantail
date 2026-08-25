/**
 * Assembling a distributable application.
 *
 * Three ingredients, always the same three: the precompiled runtime, the
 * generated `vantail.json`, and the built web assets. Where they go is the
 * only thing that differs per platform, and the runtime already knows how to
 * find its config in either layout.
 */

import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { writeRuntimeConfig } from "../runtime-config.js";
import { safeName, type BundleInput, type BundleResult } from "./common.js";
import { writeMacBundle } from "./macos.js";

export * from "./common.js";

export async function bundle(input: BundleInput): Promise<BundleResult> {
  await mkdir(input.outDir, { recursive: true });

  return input.platform === "darwin" ? writeMacBundle(input) : writePortable(input);
}

/**
 * Windows and Linux: a folder with the executable at the top and everything
 * else in `resources/`, which is the second place the runtime looks.
 */
async function writePortable(input: BundleInput): Promise<BundleResult> {
  const name = safeName(input.config.app.name);
  const root = join(input.outDir, name);
  const executable = join(root, input.platform === "win32" ? `${name}.exe` : name);
  const resources = join(root, "resources");

  await rm(root, { recursive: true, force: true });
  await mkdir(resources, { recursive: true });

  await cp(input.runtimePath, executable);
  await chmod(executable, 0o755);
  await cp(input.distDir, join(resources, "dist"), { recursive: true });

  // Windows and Linux take the window icon from a file at runtime; macOS
  // reads it from the bundle instead.
  if (input.icons) {
    await writeFile(join(resources, "icon.png"), input.icons.png.get(256)!);
    await writeFile(join(resources, "icon.ico"), input.icons.ico);
  }

  await writeRuntimeConfig(join(resources, "vantail.json"), {
    config: input.config,
    root: input.root,
    distDir: "dist",
    ...(input.icons ? { icon: "../icon.png" } : {}),
  });

  return { path: root, kind: "portable" };
}
