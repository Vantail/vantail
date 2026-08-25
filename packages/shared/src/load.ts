/**
 * Loading `vantail.config.ts`.
 *
 * Node can run TypeScript directly these days, but only the subset it can
 * strip types from - and a config that imports from a workspace package still
 * has to resolve. So the config is bundled first, with everything that is not
 * a relative import left external, and the result imported once.
 *
 * The temporary bundle is written next to the config file so that Node
 * resolves those externals from the project's own `node_modules`.
 */

import { rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import type { VantailConfig } from "./config.js";
import { parseConfig, type ParsedConfig } from "./schema.js";

/** Accepted config file names, in the order they are looked for. */
export const CONFIG_FILE_NAMES = [
  "vantail.config.ts",
  "vantail.config.mts",
  "vantail.config.js",
  "vantail.config.mjs",
] as const;

export interface LoadedProjectConfig {
  config: ParsedConfig;
  /** Absolute path to the config file. */
  path: string;
  /** Directory the config lives in - the project root. */
  root: string;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(message: string, problems: string[] = []) {
    super(
      problems.length
        ? `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
        : message,
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** Find a config file at or above `from`. */
export function findConfigFile(from: string): string | undefined {
  let current = resolve(from);
  while (true) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function loadConfig(options: {
  cwd?: string;
  /** An explicit `--config` path. Skips the search. */
  path?: string;
}): Promise<LoadedProjectConfig> {
  const cwd = options.cwd ?? process.cwd();
  const path = options.path
    ? isAbsolute(options.path)
      ? options.path
      : resolve(cwd, options.path)
    : findConfigFile(cwd);

  if (!path) {
    throw new ConfigError(
      `No ${CONFIG_FILE_NAMES[0]} found in ${cwd} or any parent directory.\n` +
        `Create one, or run \`vantail\` from inside a Vantail project.`,
    );
  }
  if (!existsSync(path)) {
    throw new ConfigError(`Config file not found: ${path}`);
  }

  const exported = await importConfigModule(path);
  const value = (exported as { default?: unknown }).default ?? exported;

  const parsed = parseConfig(value);
  if (!parsed.ok) {
    throw new ConfigError(
      `Invalid config in ${basename(path)}:`,
      parsed.problems,
    );
  }

  return { config: parsed.config, path, root: dirname(path) };
}

async function importConfigModule(path: string): Promise<unknown> {
  const bundled = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: `node${process.versions.node.split(".")[0]}`,
    // Only inline the project's own files. Package imports stay external so
    // that `defineConfig` does not drag a bundler's worth of code in with it.
    packages: "external",
    sourcemap: false,
    logLevel: "silent",
  });

  const code = bundled.outputFiles?.[0]?.text;
  if (code === undefined) {
    throw new ConfigError(`Could not bundle ${path}`);
  }

  // Unique name so repeated loads (a dev-server restart) are not served from
  // Node's module cache.
  const temporary = join(
    dirname(path),
    `.vantail.config.${process.pid}.${Date.now().toString(36)}.mjs`,
  );

  try {
    await writeFile(temporary, code, "utf8");
    return await import(pathToFileURL(temporary).href);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Re-exported so callers get the input type without a second import. */
export type { VantailConfig, ParsedConfig };
