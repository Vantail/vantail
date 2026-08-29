/**
 * Turning `vantail.config.ts` into the `vantail.json` the runtime reads.
 *
 * The runtime deliberately knows nothing about projects, dev servers or
 * bundlers - it reads one flat file. This is where that file is produced.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { ParsedConfig } from "@vantail/shared/load";
import type { RuntimeVariant } from "@vantail/runtime";

export interface RuntimeConfigInput {
  config: ParsedConfig;
  /** Project root - the directory holding `vantail.config.ts`. */
  root: string;
  /** Set for `vantail dev`: the URL the webview should load. */
  devUrl?: string;
  /**
   * Overrides `distDir`. Written verbatim, so an absolute path works and a
   * relative one is resolved against the generated file's own directory.
   */
  distDir?: string;
  /** Overrides `app.icon`, for a bundle where it has been copied elsewhere. */
  icon?: string;
}

export function buildRuntimeConfig(input: RuntimeConfigInput): Record<string, unknown> {
  const { config, root, devUrl } = input;

  const distDir =
    input.distDir ??
    // Nothing is built in dev, but `os.resourceDir()` should still point
    // somewhere sensible - so use the absolute path a build would write to.
    absolute(root, config.distDir ?? "dist");

  return {
    app: {
      name: config.app.name,
      identifier: config.app.identifier,
      version: config.app.version ?? "0.0.0",
      ...(input.icon ?? config.app.icon
        ? { icon: input.icon ?? absolute(root, config.app.icon!) }
        : {}),
    },
    ...(config.window ? { window: config.window } : {}),
    ...(config.permissions ? { permissions: config.permissions } : {}),
    ...(config.menu ? { menu: withMenuTypes(config.menu) } : {}),
    ...(config.tray ? { tray: withTrayTypes(config.tray) } : {}),
    ...(config.updater ? { updater: config.updater } : {}),
    ...(config.protocols?.length ? { protocols: config.protocols } : {}),
    ...(config.singleInstance === undefined
      ? {}
      : { singleInstance: config.singleInstance }),
    ...(config.quitOnLastWindowClosed === undefined
      ? {}
      : { quitOnLastWindowClosed: config.quitOnLastWindowClosed }),
    distDir,
    devtools: config.devtools ?? devUrl !== undefined,
    ...(devUrl ? { dev: { url: devUrl } } : {}),
  };
}

/** Write a runtime config and return its path. */
export async function writeRuntimeConfig(path: string, input: RuntimeConfigInput): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(buildRuntimeConfig(input), null, 2)}\n`, "utf8");
  return path;
}

/** Where `vantail dev` keeps its generated config. */
export function devConfigPath(root: string): string {
  return join(root, ".vantail", "dev", "vantail.json");
}

/**
 * Fill in the `type` the runtime insists on.
 *
 * `{ id, label }` is the overwhelmingly common menu item, so the config lets
 * you write just that - but the runtime's parser is a tagged union with no
 * default, which is what keeps a typo in `type` from being ignored.
 */
function withMenuTypes(items: readonly unknown[]): unknown[] {
  return items.map((item) => {
    if (typeof item !== "object" || item === null) return item;
    const entry = item as Record<string, unknown>;
    const type = typeof entry["type"] === "string" ? entry["type"] : "normal";
    return {
      ...entry,
      type,
      ...(Array.isArray(entry["items"]) ? { items: withMenuTypes(entry["items"]) } : {}),
    };
  });
}

function withTrayTypes(tray: Record<string, unknown>): Record<string, unknown> {
  return Array.isArray(tray["menu"])
    ? { ...tray, menu: withMenuTypes(tray["menu"]) }
    : tray;
}

function absolute(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

/**
 * Which runtime build this application needs.
 *
 * The only thing that changes it today is database encryption: SQLCipher is
 * about 3 MB of crypto, so it is a separate build rather than something every
 * application carries. Declaring `permissions.database.encryption` is what
 * asks for it, and `vantail dev`, `vantail package` and `vantail doctor` all
 * come here rather than each deciding for themselves.
 */
export function runtimeVariantFor(config: {
  permissions?: { database?: boolean | { encryption?: boolean } };
}): RuntimeVariant {
  const database = config.permissions?.database;
  const encrypted =
    typeof database === "object" && database !== null && database.encryption === true;
  return encrypted ? "sqlcipher" : "default";
}
