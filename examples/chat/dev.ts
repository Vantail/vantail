/**
 * `bun run dev` - Tailwind, then Hono, then the window.
 *
 * `vantail dev` starts Vite and points the window at it, which is the right
 * thing for a bundled front end and no use to a server-rendered one. So this
 * example does that job itself, and the job turns out to be small: build the
 * assets, listen on a port, and hand the runtime a config whose `dev.url` is
 * that port. The runtime is a window pointed at a URL; nothing about it cares
 * what is answering.
 *
 * The three pieces come from the same packages the CLI uses:
 *   `buildRuntimeConfig`   the config file the binary reads
 *   `resolveRuntimeBinary` where that binary is
 *   `vantail.config.ts`    the app's own settings, unchanged
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRuntimeConfig } from "@vantail/cli";
import { resolveRuntimeBinary } from "@vantail/runtime";

import config from "./vantail.config.ts";
import { buildAssets } from "./src/assets.ts";
import { createApp } from "./src/server.ts";
import { serveAssets } from "./src/static.ts";

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");

buildAssets(root, publicDir);

const runtime = resolveRuntimeBinary({ cwd: root });

// The app plus the built files it links to. Only a real server needs those
// routes: a packaged build is loaded from `vantail://` and the runtime
// serves the same directory itself.
const app = createApp();
serveAssets(app, publicDir);

const server = Bun.serve({ port: 0, fetch: app.fetch });
const url = `http://127.0.0.1:${server.port}/`;

// The same file `vantail dev` writes, built by the same function - so the
// window gets the title bar height, the background colour and the menu from
// `vantail.config.ts` exactly as it would through the CLI.
const configPath = join(root, ".vantail", "dev.json");
mkdirSync(dirname(configPath), { recursive: true });
writeFileSync(
  configPath,
  JSON.stringify(buildRuntimeConfig({ config, root, devUrl: url }), null, 2),
);

console.log(`\n  ${config.app.name}`);
console.log(`  hono     ${url}`);
console.log(`  runtime  ${runtime.path}\n`);

const child = spawn(runtime.path, ["--config", configPath], {
  stdio: "inherit",
});

// The window closing ends the run, the way `vantail dev` does it.
child.on("exit", (code) => {
  void server.stop(true);
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill();
    void server.stop(true);
  });
}
