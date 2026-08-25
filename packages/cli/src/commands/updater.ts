/**
 * `vantail updater ...`
 *
 * The publishing half of the self-updater: make a key, sign an archive, and
 * write the manifest an application checks against.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { loadConfig } from "@vantail/shared/load";

import { log, style } from "../log.js";
import { generateKeys, loadPrivateKey, publicKeyOf, signPayload } from "../updater-keys.js";

export interface KeygenOptions {
  cwd: string;
  /** Where to write the private key. */
  out?: string;
  force?: boolean;
}

export async function keygen(options: KeygenOptions): Promise<number> {
  const path = resolve(options.cwd, options.out ?? ".vantail/updater.key");

  if (existsSync(path) && !options.force) {
    log.error(
      `${path} already exists.\n` +
        `Overwriting it would make every installed copy of your app unable to update. ` +
        `Pass --force if you are certain.`,
    );
    return 1;
  }

  const keys = generateKeys();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, keys.privateKeyPem, "utf8");
  // The whole security of the update channel is this file staying secret.
  await chmod(path, 0o600);

  log.ok(`private key  ${path}`);
  log.blank();
  console.log("Add this to vantail.config.ts:");
  console.log(
    style.dim(`
  updater: {
    endpoint: "https://example.com/updates/latest.json",
    publicKey: ${JSON.stringify(keys.publicKey)},
  },
`),
  );
  log.warn("keep the private key out of version control - it is the only thing that stops someone else shipping an update to your users");
  return 0;
}

export interface SignOptions {
  cwd: string;
  file: string;
  key?: string;
}

export async function sign(options: SignOptions): Promise<number> {
  const key = await loadPrivateKey(resolveKeyPath(options.cwd, options.key));
  const payload = await readFile(resolve(options.cwd, options.file));
  const signature = signPayload(key, payload);

  console.log(signature);
  return 0;
}

export interface ManifestOptions {
  cwd: string;
  config?: string;
  /** Archives to include, as `<target>=<path>` or just `<path>`. */
  artifacts: string[];
  /** Base URL the archives will be served from. */
  baseUrl?: string;
  key?: string;
  out?: string;
  notes?: string;
  /** ISO timestamp. The caller supplies it so the output is reproducible. */
  date?: string;
}

/**
 * Write the JSON an application's `updater.endpoint` should serve.
 *
 * ```json
 * {
 *   "version": "1.2.0",
 *   "platforms": {
 *     "darwin-aarch64": { "url": "...", "signature": "..." }
 *   }
 * }
 * ```
 */
export async function manifest(options: ManifestOptions): Promise<number> {
  const loaded = await loadConfig({
    cwd: options.cwd,
    ...(options.config ? { path: options.config } : {}),
  });

  const key = await loadPrivateKey(resolveKeyPath(options.cwd, options.key));

  const configured = loaded.config.updater?.publicKey;
  if (configured && configured !== publicKeyOf(key)) {
    log.error(
      "This key does not match `updater.publicKey` in your config.\n" +
        "Signing with it would produce an update your users' apps refuse to install.",
    );
    return 1;
  }

  const platforms: Record<string, { url: string; signature: string }> = {};

  for (const artifact of options.artifacts) {
    const [target, path] = splitArtifact(artifact);
    const file = resolve(options.cwd, path);
    const signature = signPayload(key, await readFile(file));
    const name = basename(file);

    platforms[target] = {
      url: options.baseUrl ? `${trimSlash(options.baseUrl)}/${encodeURIComponent(name)}` : name,
      signature,
    };
    log.step(`${target.padEnd(16)} ${name}`);
  }

  const document = {
    version: loaded.config.app.version ?? "0.0.0",
    ...(options.notes ? { notes: options.notes } : {}),
    ...(options.date ? { pubDate: options.date } : {}),
    platforms,
  };

  const out = resolve(options.cwd, options.out ?? join("build", "latest.json"));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  log.ok(`manifest  ${out}`);
  return 0;
}

/** `darwin-aarch64=path/to.tar.gz`, or a path whose name carries the target. */
function splitArtifact(artifact: string): [string, string] {
  const equals = artifact.indexOf("=");
  if (equals !== -1) {
    return [artifact.slice(0, equals), artifact.slice(equals + 1)];
  }

  const name = basename(artifact);
  const match = /-(darwin|windows|linux)-([A-Za-z0-9_]+)\.tar\.gz$/.exec(name);
  if (!match) {
    throw new Error(
      `Cannot tell which platform ${name} is for. ` +
        `Name it <app>-<version>-<platform>-<arch>.tar.gz, or pass it as <target>=<path>.`,
    );
  }
  return [`${match[1]}-${match[2]}`, artifact];
}

function resolveKeyPath(cwd: string, key?: string): string | undefined {
  if (key) return resolve(cwd, key);
  const fallback = resolve(cwd, ".vantail/updater.key");
  return existsSync(fallback) ? fallback : undefined;
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
