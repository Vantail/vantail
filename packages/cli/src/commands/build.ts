/**
 * `vantail build`
 *
 * Build the web assets. That is all this does - turning them into something
 * double-clickable is `vantail package`, so a CI job can do one without the
 * other.
 */

import { readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { loadConfig } from "@vantail/shared/load";

import { formatBytes, log, style } from "../log.js";
import { importVite, inlineConfig, type ProjectContext } from "../vite.js";

export interface BuildOptions {
  cwd: string;
  config?: string;
  mode?: string;
}

export interface BuildResult {
  project: ProjectContext;
  /** Absolute path to the built assets. */
  distDir: string;
}

export async function build(options: BuildOptions): Promise<BuildResult> {
  const loaded = await loadConfig({
    cwd: options.cwd,
    ...(options.config ? { path: options.config } : {}),
  });
  const project: ProjectContext = {
    config: loaded.config,
    root: loaded.root,
    configPath: loaded.path,
  };

  const vite = await importVite(project.root);

  log.info(`building ${style.bold(project.config.app.name)}`);
  await vite.build(
    await inlineConfig(project, options.mode ? { mode: options.mode } : {}),
  );

  const distDir = resolveDist(project);
  const size = await directorySize(distDir);
  log.ok(`${relative(project.root, distDir) || "."} ${style.dim(formatBytes(size))}`);

  return { project, distDir };
}

export function resolveDist(project: ProjectContext): string {
  const distDir = project.config.distDir ?? "dist";
  return isAbsolute(distDir) ? distDir : resolve(project.root, distDir);
}

async function directorySize(path: string): Promise<number> {
  let total = 0;

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        total += (await stat(child)).size;
      }
    }
  };

  try {
    await walk(path);
  } catch {
    return 0;
  }
  return total;
}
