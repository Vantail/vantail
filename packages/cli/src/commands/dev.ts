/**
 * `vantail dev`
 *
 * Start Vite, point a native window at it, and keep the two alive together.
 * Closing the window stops the server; stopping the CLI closes the window.
 *
 * The window is a real webview against a real dev server, so HMR, React
 * Refresh, source maps and devtools all work exactly as they do in a browser.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { resolveRuntimeBinary } from "@vantail/runtime";
import { loadConfig } from "@vantail/shared/load";

import { log, style } from "../log.js";
import { devConfigPath, writeRuntimeConfig } from "../runtime-config.js";
import { importVite, inlineConfig, type ProjectContext } from "../vite.js";

export interface DevOptions {
  cwd: string;
  config?: string;
  port?: number;
  host?: string;
}

export async function dev(options: DevOptions): Promise<number> {
  const loaded = await loadConfig({
    cwd: options.cwd,
    ...(options.config ? { path: options.config } : {}),
  });

  let project: ProjectContext = {
    config: loaded.config,
    root: loaded.root,
    configPath: loaded.path,
  };

  // Fail before starting Vite if there is no runtime to start.
  const runtime = resolveRuntimeBinary({ cwd: project.root });
  const vite = await importVite(project.root);

  const server = await vite.createServer(
    await inlineConfig(project, {
      server: {
        ...(options.port !== undefined ? { port: options.port } : {}),
        ...(options.host !== undefined ? { host: options.host } : {}),
      },
    }),
  );
  await server.listen();

  const url = server.resolvedUrls?.local?.[0];
  if (!url) {
    await server.close();
    throw new Error("Vite started but reported no local URL to open.");
  }

  const version = project.config.app.version;
  log.info(`${style.bold(project.config.app.name)}${version ? style.dim(` ${version}`) : ""}`);
  log.step(`vite     ${url}`);
  log.step(`runtime  ${runtime.path}${runtime.source === "workspace" ? " (local build)" : ""}`);
  log.blank();

  const configPath = devConfigPath(project.root);

  let child: ChildProcess | undefined;
  let watcher: FSWatcher | undefined;
  let restarting = false;
  let stopping = false;
  let settle: (code: number) => void = () => {};

  const finish = (code: number): void => {
    if (stopping) return;
    stopping = true;
    watcher?.close();
    void (async () => {
      await stopRuntime();
      await server.close();
      await rm(configPath, { force: true });
      settle(code);
    })();
  };

  const stopRuntime = (): Promise<void> =>
    new Promise((resolve) => {
      const running = child;
      if (!running || running.exitCode !== null || running.signalCode !== null) return resolve();

      let done = false;
      const settled = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      running.once("exit", settled);
      running.kill("SIGTERM");
      // If the window has not gone in a second, insist.
      const timer = setTimeout(() => {
        running.kill("SIGKILL");
        settled();
      }, 1000);
      timer.unref();
    });

  const startRuntime = async (): Promise<void> => {
    await writeRuntimeConfig(configPath, {
      config: project.config,
      root: project.root,
      devUrl: url,
    });

    const started = spawn(runtime.path, ["--config", configPath], {
      cwd: project.root,
      stdio: "inherit",
      env: { ...process.env, VANTAIL_DEV: "1" },
    });
    child = started;

    started.once("exit", (code, signal) => {
      if (restarting || stopping) return;
      // A window the user closed is a clean exit, not a failure.
      finish(signal ? 0 : (code ?? 0));
    });
    started.once("error", (error) => {
      log.error(`Could not start the runtime: ${error.message}`);
      finish(1);
    });
  };

  // Window size, permissions and app identity are all read once at startup,
  // so a config change means a new window rather than a hot update.
  watcher = watchFile(project.configPath, async () => {
    if (stopping || restarting) return;
    restarting = true;
    try {
      const reloaded = await loadConfig({ cwd: project.root, path: project.configPath });
      project = { config: reloaded.config, root: reloaded.root, configPath: reloaded.path };
      log.info("config changed, reopening the window");
      await stopRuntime();
      await startRuntime();
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      log.warn("keeping the current window - fix the config and save again");
    } finally {
      restarting = false;
    }
  });

  const onSignal = (): void => finish(0);

  try {
    const code = await new Promise<number>((resolve) => {
      // Registered inside the executor so `settle` is already in place: a
      // Ctrl-C landing between the two would otherwise resolve nothing.
      settle = resolve;
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      void startRuntime();
    });
    return code;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/**
 * Watch a single file across editors. Many save by replacing the file, which
 * breaks a watch on the file itself, so watch its directory instead.
 */
function watchFile(path: string, onChange: () => void): FSWatcher | undefined {
  const name = basename(path);
  try {
    let timer: NodeJS.Timeout | undefined;
    return watch(dirname(path), (_event, changed) => {
      if (changed !== name) return;
      // One save often produces several events.
      clearTimeout(timer);
      timer = setTimeout(onChange, 50);
    });
  } catch {
    // Watching is a convenience; a platform without it still runs fine.
    return undefined;
  }
}
