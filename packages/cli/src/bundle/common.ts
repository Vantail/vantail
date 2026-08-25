import type { ParsedConfig } from "@vantail/shared/load";

import type { IconSet } from "../icons/index.js";

export interface BundleInput {
  config: ParsedConfig;
  root: string;
  /** Built web assets. */
  distDir: string;
  /** The precompiled runtime executable. */
  runtimePath: string;
  /** Directory bundles are written to. */
  outDir: string;
  platform: NodeJS.Platform;
  /** macOS only: codesign identity, or `-` for an ad-hoc signature. */
  sign?: string | undefined;
  /** Generated from `app.icon`, when there is one. */
  icons?: IconSet | undefined;
}

export interface BundleResult {
  /** The thing a user launches. */
  path: string;
  kind: "app" | "portable";
}

/**
 * The key the runtime looks for in an update manifest.
 *
 * Rust and Node disagree about how to spell an architecture, and the runtime
 * builds this string from Rust's names - so the translation happens here,
 * once, rather than in every publishing script.
 */
export function updateTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : platform;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  return `${os}-${cpu}`;
}

/** A file name that survives every filesystem we target. */
export function safeName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ._-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return cleaned.length > 0 ? cleaned : "app";
}
