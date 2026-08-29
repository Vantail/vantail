/**
 * `vantail doctor`
 *
 * Answers the only question that matters when something will not start:
 * which of the four moving parts is missing.
 */

import { spawn } from "node:child_process";

import {
  resolveRuntimeBinary,
  RuntimeNotFoundError,
  type RuntimeVariant,
} from "@vantail/runtime";
import { findConfigFile, loadConfig } from "@vantail/shared/load";

import { log, style } from "../log.js";
import { runtimeVariantFor } from "../runtime-config.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface DoctorOptions {
  cwd: string;
  config?: string;
}

export async function doctor(options: DoctorOptions): Promise<number> {
  const checks: Check[] = [];

  checks.push(nodeCheck());
  const project = await configCheck(options, checks);
  await viteCheck(project?.root ?? options.cwd, checks);
  await runtimeCheck(project?.root ?? options.cwd, project?.variant ?? "default", checks);
  checks.push(platformCheck());

  log.blank();
  for (const check of checks) {
    const mark = check.ok ? style.green("ok  ") : style.red("fail");
    console.log(`  ${mark}  ${check.name.padEnd(10)} ${check.detail}`);
    if (check.hint) console.log(`        ${style.dim(check.hint)}`);
  }
  log.blank();

  const failures = checks.filter((check) => !check.ok).length;
  if (failures === 0) {
    log.ok("everything is in place");
    return 0;
  }
  log.error(`${failures} ${failures === 1 ? "problem" : "problems"} found`);
  return 1;
}

function nodeCheck(): Check {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const ok = major > 20 || (major === 20 && minor >= 19);
  return {
    name: "node",
    ok,
    detail: process.versions.node,
    ...(ok ? {} : { hint: "Vantail needs Node 20.19 or newer" }),
  };
}

async function configCheck(
  options: DoctorOptions,
  checks: Check[],
): Promise<{ root: string; variant: RuntimeVariant } | undefined> {
  const found = options.config ?? findConfigFile(options.cwd);
  if (!found) {
    checks.push({
      name: "config",
      ok: false,
      detail: "no vantail.config.ts found",
      hint: `looked in ${options.cwd} and its parents`,
    });
    return undefined;
  }

  try {
    const loaded = await loadConfig({
      cwd: options.cwd,
      ...(options.config ? { path: options.config } : {}),
    });
    checks.push({
      name: "config",
      ok: true,
      detail: `${loaded.path} ${style.dim(`(${loaded.config.app.identifier})`)}`,
    });
    return { root: loaded.root, variant: runtimeVariantFor(loaded.config) };
  } catch (error) {
    checks.push({
      name: "config",
      ok: false,
      detail: found,
      hint:
        error instanceof Error ? error.message.split("\n")[0] : String(error),
    });
    return undefined;
  }
}

async function viteCheck(root: string, checks: Check[]): Promise<void> {
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(`${root}/package.json`);
    const manifest = require("vite/package.json") as { version: string };
    checks.push({ name: "vite", ok: true, detail: manifest.version });
  } catch {
    checks.push({
      name: "vite",
      ok: false,
      detail: "not installed",
      hint: "npm install --save-dev vite",
    });
  }
}

async function runtimeCheck(
  root: string,
  variant: RuntimeVariant,
  checks: Check[],
): Promise<void> {
  try {
    const runtime = resolveRuntimeBinary({ cwd: root, variant });
    const version = await runtimeVersion(runtime.path);
    checks.push({
      name: "runtime",
      ok: version !== undefined,
      detail: `${version ?? "did not respond"} ${style.dim(
        `(${runtime.source}${runtime.profile ? `, ${runtime.profile}` : ""})`,
      )}`,
      ...(version === undefined ? { hint: runtime.path } : {}),
    });

    if (version === undefined) return;

    const features = await runtimeFeatures(runtime.path);
    if (features === undefined) return;

    checks.push({
      name: "features",
      ok: true,
      detail: features === "" ? style.dim("none - a minimal build") : features,
    });
  } catch (error) {
    checks.push({
      name: "runtime",
      ok: false,
      detail: "not found",
      hint:
        error instanceof RuntimeNotFoundError
          ? `npm install --save-optional ${error.packageName}`
          : String(error),
    });
  }
}

function platformCheck(): Check {
  // Linux is exercised now - the suite runs there in a container, on X11.
  // Wayland runs but has a known protocol error under load; see the README.
  const hint =
    process.platform === "linux"
      ? "Linux runs on X11; Wayland has a known issue under load"
      : undefined;

  return {
    name: "platform",
    ok: true,
    detail: `${process.platform}-${process.arch}`,
    ...(hint ? { hint } : {}),
  };
}

function runtimeVersion(path: string): Promise<string | undefined> {
  return ask(path, "--version");
}

/**
 * Which capabilities this runtime was compiled with.
 *
 * They are compile-time features, so two runtimes reporting the same version
 * can behave differently: one built without `secrets` answers `UNSUPPORTED`
 * to every call, which reads like a bug until you know. `--features` is newer
 * than the flag itself, so an older runtime answers nothing and this stays
 * quiet rather than claiming the list is empty.
 */
function runtimeFeatures(path: string): Promise<string | undefined> {
  return ask(path, "--features");
}

function ask(path: string, flag: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(path, [flag], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", () => resolve(undefined));
    child.once("exit", (code) =>
      resolve(code === 0 ? output.trim() : undefined),
    );
  });
}
