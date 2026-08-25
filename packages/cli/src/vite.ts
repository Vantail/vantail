/**
 * Talking to Vite.
 *
 * Vite is a peer dependency, imported lazily so that a project missing it
 * gets a sentence explaining what to install rather than a module resolution
 * stack trace.
 */

import type { InlineConfig, ViteDevServer } from "vite";

import type { ParsedConfig } from "@vantail/shared/load";

export interface ProjectContext {
  config: ParsedConfig;
  root: string;
  configPath: string;
}

interface ViteModule {
  createServer(config: InlineConfig): Promise<ViteDevServer>;
  build(config: InlineConfig): Promise<unknown>;
  version?: string;
}

export async function importVite(root: string): Promise<ViteModule> {
  try {
    return (await import("vite")) as unknown as ViteModule;
  } catch {
    throw new Error(
      `Vite is not installed in ${root}.\n` +
        `Vantail builds your interface with Vite - add it with:\n  npm install --save-dev vite`,
    );
  }
}

/** The Vite config Vantail runs with, before the plugin adds its defaults. */
export async function inlineConfig(
  project: ProjectContext,
  extra: InlineConfig = {},
): Promise<InlineConfig> {
  const { default: vantail } = await import("@vantail/vite");

  return {
    // A project's own vite.config.ts is still loaded and still wins; the
    // Vantail plugin only supplies defaults through the `config` hook.
    root: project.root,
    ...extra,
    plugins: [
      vantail({ resolved: { config: project.config, root: project.root } }),
      ...(extra.plugins ?? []),
    ],
  };
}
