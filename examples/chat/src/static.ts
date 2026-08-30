/**
 * Serving the built assets from disk, for the versions of this that run as a
 * real HTTP server.
 *
 * Kept out of `server.ts` so that file has no file system in it: the packaged
 * build runs those routes inside the webview, where `node:fs` does not exist
 * and a bundler would refuse before it ever ran.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Hono } from "hono";

const TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export function serveAssets(app: Hono, dir: string) {
  for (const name of ["app.css", "htmx.js", "client.js"]) {
    const type = TYPES[name.slice(name.lastIndexOf("."))]!;
    app.get(`/${name}`, async () => {
      const body = await readFile(join(dir, name));
      return new Response(body, {
        headers: { "content-type": type, "cache-control": "no-store" },
      });
    });
  }
}
