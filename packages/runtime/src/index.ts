/**
 * Finding the native runtime.
 *
 * Application developers never compile Rust. The runtime is a precompiled
 * binary published per platform, and this module is the only thing that knows
 * where it might be:
 *
 * 1. `$VANTAIL_RUNTIME_BIN` - an explicit override, for CI and for anyone
 *    hacking on the runtime itself.
 * 2. `@vantail/runtime-<platform>-<arch>` - the published binary, installed
 *    as an optional dependency so only the current platform is downloaded.
 *    An application that needs database encryption uses the `sqlcipher`
 *    variant of the same package instead, which is a separate build because
 *    the crypto it carries costs about 3 MB.
 * 3. A `cargo build` inside this repository - how Vantail's own examples run
 *    before anything is published.
 *
 * Step 2 is only attempted for a platform `platforms.json` says is published.
 * Naming a package that was never built produces an install command that 404s,
 * which is a worse answer than saying the platform is out of scope.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeSource = "env" | "package" | "workspace";

/**
 * Which build of the runtime an application needs.
 *
 * `default` is every capability except database encryption. `sqlcipher` is
 * the same plus SQLCipher, and is roughly 3 MB larger - which is why it is a
 * variant rather than what everybody gets.
 */
export type RuntimeVariant = "default" | "sqlcipher";

export interface RuntimeResolution {
  /** Absolute path to the runtime executable. */
  path: string;
  source: RuntimeSource;
  /** The npm package it came from, when it came from one. */
  package?: string;
  /** Which Cargo profile a workspace build came from. */
  profile?: "release" | "debug";
}

export interface ResolveOptions {
  /** Where to start looking for a project or workspace. Defaults to `cwd`. */
  cwd?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /**
   * Which build of the runtime to look for. Defaults to `default`.
   *
   * Only the published package is variant-specific: `$VANTAIL_RUNTIME_BIN`
   * and a local `cargo build` are whatever you pointed at or compiled, and
   * are used as-is.
   */
  variant?: RuntimeVariant;
  /**
   * Which local build to prefer when both exist. Only affects the workspace
   * fallback; a published package has no profiles.
   *
   * - `newest` (default) - whatever was built last, which is what you want
   *   while iterating on the runtime.
   * - `release` - for packaging, where picking up a debug build means
   *   shipping something ten times the size for no reason.
   */
  prefer?: "newest" | "release";
}

/** One target the release pipeline publishes a runtime for. */
export interface SupportedTarget {
  /** The npm package carrying the default build for this target. */
  package: string;
  platform: NodeJS.Platform;
  arch: string;
  /** The Rust target triple it is compiled from. */
  rust: string;
  /** 1 is exercised on every change, 2 is built and smoke tested. */
  tier: number;
}

let targets: SupportedTarget[] | undefined;

/**
 * The targets a runtime is published for.
 *
 * Read from `platforms.json` rather than written out here. That file is what
 * the release pipeline builds from, and it ships inside this package, so the
 * list an installed copy reports is the list that was actually published.
 * Adding a platform stays one row there instead of an edit in four places.
 */
export function supportedTargets(): SupportedTarget[] {
  if (!targets) {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "platforms.json");
    ({ targets } = JSON.parse(readFileSync(path, "utf8")) as { targets: SupportedTarget[] });
  }
  return targets;
}

/** Every published target as `platform-arch`, for saying so in a message. */
export function supportedPlatformNames(): string[] {
  return supportedTargets().map((target) => `${target.platform}-${target.arch}`);
}

export function isSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return supportedTargets().some(
    (target) => target.platform === platform && target.arch === arch,
  );
}

/**
 * Asked for a platform no runtime is published for.
 *
 * Distinct from `RuntimeNotFoundError` because the answer is different. Not
 * found means supported but not installed here, and `npm install` fixes it.
 * This means there is nothing to install, and an install command would 404 -
 * which is what this package used to tell people on an Intel Mac.
 */
export class UnsupportedPlatformError extends Error {
  readonly platform: string;
  readonly arch: string;
  /** Every `platform-arch` there is a published runtime for. */
  readonly supported: string[];

  constructor(platform: string, arch: string, supported: string[]) {
    super(
      `Vantail publishes no runtime for ${platform}-${arch}.\n\n` +
        `Published platforms:\n${supported.map((name) => `  ${name}`).join("\n")}\n\n` +
        `If you have built the runtime yourself, point at it:\n` +
        `  export VANTAIL_RUNTIME_BIN=/path/to/vantail-runtime`,
    );
    this.name = "UnsupportedPlatformError";
    this.platform = platform;
    this.arch = arch;
    this.supported = supported;
  }
}

export class RuntimeNotFoundError extends Error {
  readonly packageName: string;

  constructor(packageName: string, tried: string[]) {
    super(
      `Could not find the Vantail runtime for this platform.\n\n` +
        `Install it with:\n  npm install --save-optional ${packageName}\n\n` +
        `Or point at a build of your own:\n  export VANTAIL_RUNTIME_BIN=/path/to/vantail-runtime\n\n` +
        `Looked in:\n${tried.map((path) => `  ${path}`).join("\n")}`,
    );
    this.name = "RuntimeNotFoundError";
    this.packageName = packageName;
  }
}

/** The npm package that carries the runtime for a platform. */
export function runtimePackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  variant: RuntimeVariant = "default",
): string {
  const suffix = variant === "default" ? "" : `-${variant}`;
  return `@vantail/runtime-${platform}-${arch}${suffix}`;
}

export function runtimeBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "vantail-runtime.exe" : "vantail-runtime";
}

export function resolveRuntimeBinary(options: ResolveOptions = {}): RuntimeResolution {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const cwd = options.cwd ?? process.cwd();
  const packageName = runtimePackageName(platform, arch, options.variant ?? "default");
  const tried: string[] = [];

  const override = process.env["VANTAIL_RUNTIME_BIN"];
  if (override) {
    const path = resolvePath(override);
    if (isExecutable(path)) return { path, source: "env" };
    tried.push(`${path} (from $VANTAIL_RUNTIME_BIN)`);
  }

  // Deliberately after the override: somebody who has pointed at their own
  // build has already answered this question, and on a platform nothing is
  // published for that is the only answer there is.
  if (!isSupportedPlatform(platform, arch)) {
    throw new UnsupportedPlatformError(platform, arch, supportedPlatformNames());
  }

  const fromPackage = fromInstalledPackage(packageName, platform, cwd, tried);
  if (fromPackage) return fromPackage;

  const fromWorkspace = fromCargoTarget(cwd, platform, tried, options.prefer ?? "newest");
  if (fromWorkspace) return fromWorkspace;

  throw new RuntimeNotFoundError(packageName, tried);
}

function fromInstalledPackage(
  packageName: string,
  platform: NodeJS.Platform,
  cwd: string,
  tried: string[],
): RuntimeResolution | undefined {
  const binary = runtimeBinaryName(platform);

  // Resolve from the project first, then from this package, so an app can pin
  // a runtime version that differs from the CLI's.
  for (const from of [join(cwd, "package.json"), fileURLToPath(import.meta.url)]) {
    try {
      const require = createRequire(from);
      const manifest = require.resolve(`${packageName}/package.json`);
      const path = join(dirname(manifest), "bin", binary);
      if (isExecutable(path)) return { path, source: "package", package: packageName };
      tried.push(path);
    } catch {
      // Not installed here; try the next resolution root.
    }
  }

  tried.push(`${packageName} (not installed)`);
  return undefined;
}

/**
 * Find a locally built runtime by walking up for the Cargo workspace that
 * contains it. Only used when developing Vantail itself.
 */
function fromCargoTarget(
  cwd: string,
  platform: NodeJS.Platform,
  tried: string[],
  prefer: "newest" | "release",
): RuntimeResolution | undefined {
  const binary = runtimeBinaryName(platform);
  const roots = [cwd, dirname(fileURLToPath(import.meta.url))];

  for (const start of roots) {
    for (const root of ancestors(start)) {
      if (!existsSync(join(root, "runtime", "Cargo.toml"))) continue;

      const candidates = (["release", "debug"] as const)
        .map((profile) => ({ profile, path: join(root, "target", profile, binary) }))
        .map((candidate) => ({ ...candidate, built: builtAt(candidate.path) }))
        .filter((candidate) => candidate.built !== undefined)
        .sort((a, b) =>
          prefer === "release"
            ? // Release first, whenever there is one.
              Number(b.profile === "release") - Number(a.profile === "release")
            : // Otherwise whatever was built last: preferring release outright
              // means a `cargo build` while debugging silently changes
              // nothing, which is a confusing hour to spend.
              b.built! - a.built!,
        );

      const newest = candidates[0];
      if (newest) {
        return { path: newest.path, source: "workspace", profile: newest.profile };
      }
      tried.push(join(root, "target", "{release,debug}", binary));
    }
  }

  return undefined;
}

/** Modification time, or `undefined` when there is no such file. */
function builtAt(path: string): number | undefined {
  try {
    const info = statSync(path);
    return info.isFile() ? info.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

function* ancestors(from: string): Generator<string> {
  let current = resolvePath(from);
  while (true) {
    yield current;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function isExecutable(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
