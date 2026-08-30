/**
 * The server as its own program, for `bun build --compile`.
 *
 * This is the only entry point that is ever compiled, so it can assume it is:
 * the assets sit beside the executable because `vantail package` copies
 * `dist/` in wholesale, binary and all.
 *
 * It picks a free port and says so on stdout, because the page that starts it
 * has no other way to find out - see `boot.ts`.
 */

import { dirname } from "node:path";

import { createApp } from "./server.ts";
import { serveAssets } from "./static.ts";

const app = createApp();
serveAssets(app, dirname(process.execPath));

const server = Bun.serve({ port: 0, fetch: app.fetch });

// The line `boot.ts` is waiting for. Flushed by the newline.
console.log(`listening on http://127.0.0.1:${server.port}/`);
