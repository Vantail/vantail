/**
 * `bun run build` - everything a packaged window needs, into `dist/`.
 *
 * `vantail package --no-build` then bundles that directory wholesale, so
 * whatever is here ends up inside the application - the assets, the boot page,
 * and the server itself as a compiled binary.
 *
 * That last part is what makes a server-rendered application packageable at
 * all. `bun build --compile` writes a single executable with the Bun runtime
 * inside it, so the machine running the app needs nothing installed. The
 * runtime knows it as `$RESOURCE/server`, which is how `permissions.shell`
 * names a sidecar shipped in the bundle.
 *
 * It is a 48MB executable and no build flag makes it smaller - see the
 * README for what that buys and what it costs.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAssets } from "./src/assets.ts";
import { bootPage } from "./src/views.ts";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

buildAssets(root, dist);

// The boot page is what the window opens, so it has to be `index.html` - the
// name the runtime asks for when nothing says otherwise.
writeFileSync(join(dist, "index.html"), bootPage());

const compile = spawnSync(
  "bunx",
  [
    "bun",
    "build",
    "src/serve.ts",
    "--compile",
    "--outfile",
    join(dist, "server"),
  ],
  { cwd: root, stdio: "inherit" },
);
if (compile.status !== 0) {
  console.error("\nCompiling the server failed.");
  process.exit(compile.status ?? 1);
}

// The boot page is bundled too, and it imports `@vantail/api`.
const boot = spawnSync(
  "bunx",
  ["bun", "build", "src/boot.ts", "--outfile", join(dist, "boot.js"), "--target", "browser"],
  { cwd: root, stdio: "inherit" },
);
if (boot.status !== 0) {
  console.error("\nBundling the boot page failed.");
  process.exit(boot.status ?? 1);
}

console.log(`\n  dist/  ready - now run:  vantail package --no-build\n`);
