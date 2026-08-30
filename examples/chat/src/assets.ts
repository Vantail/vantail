/**
 * The three static files the page asks for, built the same way for `bun run
 * dev` and `bun run build`.
 *
 * Shared so that what a packaged window loads is what the dev window loaded,
 * rather than two similar-looking pipelines that drift.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function run(what: string, command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n${what} failed.`);
    process.exit(result.status ?? 1);
  }
}

export function buildAssets(root: string, outDir: string) {
  mkdirSync(outDir, { recursive: true });

  // Tailwind first: the page asks for `/app.css` on its first paint, and a
  // stylesheet that arrives late is a window that opens unstyled and flinches.
  run(
    "Tailwind",
    "bunx",
    ["@tailwindcss/cli", "-i", "src/app.css", "-o", join(outDir, "app.css")],
    root,
  );

  // Copied out of `node_modules` rather than linked to a CDN, because a
  // desktop application should open with the network unplugged.
  copyFileSync(
    join(root, "node_modules/htmx.org/dist/htmx.min.js"),
    join(outDir, "htmx.js"),
  );

  // Bundled because it imports `@vantail/api`, which a browser cannot resolve
  // by name.
  run(
    "Bundling the client",
    "bunx",
    [
      "bun",
      "build",
      "src/client.ts",
      "--outfile",
      join(outDir, "client.js"),
      "--target",
      "browser",
    ],
    root,
  );
}
