/**
 * `vantail package`
 *
 * Build, then lay the three pieces out in the shape the platform expects.
 * No Rust toolchain is involved: the runtime is a precompiled binary that
 * gets copied in.
 */

import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveRuntimeBinary } from "@vantail/runtime";
import { DEFAULT_OUT_DIR } from "@vantail/shared";
import { loadConfig } from "@vantail/shared/load";

import { tarGzip } from "../bundle/archive.js";
import { buildIcons, loadIcon, type IconSet } from "../icons/index.js";
import { buildInstaller } from "../installers/index.js";
import { bundle, safeName, updateTarget } from "../bundle/index.js";
import { formatBytes, log, style } from "../log.js";
import { runtimeVariantFor } from "../runtime-config.js";
import type { ProjectContext } from "../vite.js";
import { build, resolveDist } from "./build.js";

export interface PackageOptions {
  cwd: string;
  config?: string;
  /** Skip the Vite build and package whatever is already in `distDir`. */
  skipBuild?: boolean;
  /** Overrides `outDir` from the config. */
  outDir?: string;
  /** macOS codesign identity. Defaults to an ad-hoc signature. */
  sign?: string;
  /** Also produce the `.tar.gz` the self-updater downloads. */
  update?: boolean;
  /** Also produce the platform's installer: .dmg, .msi or .deb. */
  installer?: boolean;
  /** Package with a debug runtime anyway. Ten times the size; rarely wanted. */
  allowDebugRuntime?: boolean;
}

export async function packageApp(options: PackageOptions): Promise<number> {
  let project;
  let distDir: string;

  if (options.skipBuild) {
    const loaded = await loadConfig({
      cwd: options.cwd,
      ...(options.config ? { path: options.config } : {}),
    });
    project = {
      config: loaded.config,
      root: loaded.root,
      configPath: loaded.path,
    };
    distDir = resolveDist(project);
  } else {
    const result = await build({
      cwd: options.cwd,
      ...(options.config ? { config: options.config } : {}),
    });
    project = result.project;
    distDir = result.distDir;
  }

  // `release`, not whatever was built most recently: a debug runtime is
  // roughly ten times the size, and shipping one by accident is far easier
  // than noticing afterwards that the bundle is 28 MB instead of 3.
  const runtime = resolveRuntimeBinary({
    cwd: project.root,
    prefer: "release",
    // An application that encrypts its database needs the build that can.
    variant: runtimeVariantFor(project.config),
  });

  if (runtime.source === "workspace") {
    log.warn(
      `packaging a locally built runtime (${runtime.profile ?? "unknown"}) - ` +
        `fine for testing, not for release`,
    );
    if (runtime.profile === "debug" && !options.allowDebugRuntime) {
      // A warning is not enough for a tenfold size difference that nobody
      // sees until they look at the finished bundle.
      throw new Error(
        "There is no release build of the runtime, only a debug one.\n" +
          "A debug binary is about ten times the size and slower, so packaging stops here.\n\n" +
          "  cargo build --release\n\n" +
          "Or pass --allow-debug-runtime if that really is what you want.",
      );
    }
  }

  const outDir = resolve(
    project.root,
    options.outDir ?? project.config.outDir ?? DEFAULT_OUT_DIR,
    process.platform,
  );

  const icons = await prepareIcons(project);

  const result = await bundle({
    config: project.config,
    root: project.root,
    distDir,
    runtimePath: runtime.path,
    outDir,
    platform: process.platform,
    sign: options.sign,
    icons,
  });

  log.ok(
    `${result.kind === "app" ? "bundle" : "folder"}  ${style.bold(result.path)}`,
  );

  if (options.update) {
    await writeUpdateArchive(project, outDir, result.path);
  }

  if (options.installer) {
    await writeInstaller(project, outDir, result.path, icons);
  }

  if (process.platform === "darwin" && !options.sign) {
    log.step(
      "signed ad-hoc: it runs here, but needs a Developer ID to run elsewhere",
    );
  }

  return 0;
}

/**
 * Wrap the bundle in whatever this platform hands to a user.
 */
async function writeInstaller(
  project: ProjectContext,
  outDir: string,
  bundlePath: string,
  icons: IconSet | undefined,
): Promise<void> {
  const version = project.config.app.version ?? "0.0.0";
  const fileStem = `${safeName(project.config.app.name)}-${version}-${updateTarget()}`;

  // WiX references the icon as a file on disk, so it has to exist first.
  if (process.platform === "win32" && icons) {
    await writeFile(resolve(outDir, `${fileStem}.ico`), icons.ico);
  }

  const result = await buildInstaller({
    config: project.config,
    root: project.root,
    bundlePath,
    outDir,
    fileStem,
    icons,
  });

  const size = await stat(result.path).then(
    (info) => ` ${style.dim(formatBytes(info.size))}`,
    () => "",
  );
  log.ok(`${result.kind.padEnd(9)} ${style.bold(result.path)}${size}`);
  if (result.note) {
    for (const line of result.note.split("\n")) log.step(line);
  }
}

/**
 * Generate every icon size from the one source image.
 *
 * A missing `app.icon` is not an error - an application without an icon gets
 * the platform's placeholder, which is exactly what it got before. A *broken*
 * one is an error, because silently shipping the placeholder is worse.
 */
async function prepareIcons(
  project: ProjectContext,
): Promise<IconSet | undefined> {
  const path = project.config.app.icon;
  if (!path) {
    log.step("no app.icon - the platform placeholder will be used");
    return undefined;
  }

  const source = await loadIcon(resolve(project.root, path));
  const icons = buildIcons(source);
  log.step(
    `icons     ${source.width}x${source.width} -> ${icons.png.size} sizes`,
  );
  return icons;
}

/**
 * Pack the bundle for the self-updater.
 *
 * Signing happens in `vantail updater manifest` rather than here, because a
 * release covers several platforms and only one machine builds each of them.
 */
async function writeUpdateArchive(
  project: { config: { app: { name: string; version?: string } } },
  outDir: string,
  bundlePath: string,
): Promise<void> {
  const target = updateTarget();
  const version = project.config.app.version ?? "0.0.0";
  const name = `${safeName(project.config.app.name)}-${version}-${target}.tar.gz`;
  const path = resolve(outDir, name);

  const archive = await tarGzip(bundlePath);
  await writeFile(path, archive);

  log.ok(
    `update    ${style.bold(path)} ${style.dim(formatBytes(archive.length))}`,
  );
  log.step(`sign it with: vantail updater manifest ${target}=${name}`);
}
