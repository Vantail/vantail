/**
 * A page from somewhere else gets nothing from the runtime.
 *
 * The bridge is injected into whatever a window loads, and the platform
 * passes IPC on from whatever a window loads - so a window that follows a link
 * to another site would otherwise hand that site every permission the
 * application holds. This loads the application, proves its own page can
 * reach the runtime, then navigates to a page served from a different origin
 * and has that page forge a call by hand.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { resolveRuntimeBinary } from "@vantail/runtime";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const headless =
  process.env.VANTAIL_SKIP_INTEGRATION === "1" ||
  (process.platform === "linux" &&
    process.env.VANTAIL_FORCE_INTEGRATION !== "1");

let runtimePath;
try {
  runtimePath = resolveRuntimeBinary({ cwd: repoRoot, prefer: "release" }).path;
} catch {
  runtimePath = undefined;
}

/** Poll until `predicate` holds, or fail saying what was last seen. */
async function until(what, read, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((wait) => setTimeout(wait, 150));
  }
  throw new Error(
    `${what} did not happen within ${timeoutMs}ms; last saw ${JSON.stringify(last)}`,
  );
}

describe(
  "pages from another origin",
  {
    skip: headless
      ? "needs a display"
      : !runtimePath
        ? "no runtime binary built"
        : false,
  },
  () => {
    let root;
    let server;
    let child;
    let stderr = "";
    /** What the foreign page reported about itself. */
    let report;

    before(async () => {
      root = await mkdtemp(join(tmpdir(), "vantail-origins-"));
      const stolen = join(root, "stolen.txt");

      // The other site. Same machine, different origin - which is all an
      // origin check can see.
      server = createServer((request, response) => {
        const url = new URL(request.url, "http://127.0.0.1");
        if (url.pathname === "/report") {
          report = Object.fromEntries(url.searchParams);
          response.writeHead(204);
          return response.end();
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<!doctype html>
<meta charset="utf-8">
<script>
(function () {
  // In a function: a top-level \`var ipc\` would be \`window.ipc\` itself.
  var bridge = typeof window.__VANTAIL__;
  var channel = typeof (window.ipc && window.ipc.postMessage);
  // Exactly what the bridge would send, written by hand.
  if (channel === "function") {
    window.ipc.postMessage(JSON.stringify({
      id: "forged",
      method: "filesystem.writeText",
      params: { path: ${JSON.stringify(stolen)}, contents: "from another origin" },
    }));
  }
  fetch("/report?bridge=" + bridge + "&ipc=" + channel);
})();
</script>`);
      });
      await new Promise((listening) =>
        server.listen(0, "127.0.0.1", listening),
      );
      const foreign = `http://127.0.0.1:${server.address().port}/`;

      await cp(
        join(repoRoot, "packages", "api", "dist"),
        join(root, "dist", "api"),
        { recursive: true },
      );
      await writeFile(
        join(root, "vantail.json"),
        JSON.stringify({
          app: {
            name: "OriginTest",
            identifier: `dev.vantail.origintest.${process.pid}`,
            version: "1.0.0",
          },
          window: { width: 360, height: 240, visible: false },
          distDir: "dist",
          permissions: {
            filesystem: { read: [`${root}/**`], write: [`${root}/**`] },
          },
        }),
      );
      // The application's own page: one real call, so a refusal later cannot
      // be a bridge that never worked, then off to the other site.
      await writeFile(
        join(root, "dist", "index.html"),
        `<!doctype html>
<meta charset="utf-8">
<script type="module">
import { invoke } from "./api/index.js";
await invoke("filesystem.writeText", {
  path: ${JSON.stringify(join(root, "own.txt"))},
  contents: "from the application",
});
location.href = ${JSON.stringify(foreign)};
</script>`,
      );

      child = spawn(runtimePath, ["--config", join(root, "vantail.json")], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr.on("data", (chunk) => (stderr += chunk));
    });

    after(async () => {
      child?.kill("SIGKILL");
      server?.close();
      if (root && !process.env.VANTAIL_KEEP) {
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 250,
        }).catch(() => {});
      }
    });

    it("lets the application's own page reach the runtime", async () => {
      const own = await until(
        "the application's own call",
        () => readFile(join(root, "own.txt"), "utf8").catch(() => undefined),
        (contents) => contents !== undefined,
      );
      assert.equal(own, "from the application");
    });

    it("does not give the other page the bridge", async () => {
      await until(
        "the other page loading",
        () => report,
        (seen) => seen !== undefined,
      );
      assert.equal(report.bridge, "undefined");
      // The platform's own channel is still there - which is why the runtime
      // has to check who is on the other end of it.
      assert.equal(report.ipc, "function");
    });

    it("refuses a call the other page forges by hand", async () => {
      await until(
        "the runtime refusing the forged call",
        () => stderr,
        (text) => text.includes("ignored a native call from http://127.0.0.1"),
      );
      // Refused before dispatch, so there is nothing still in flight that
      // could write it a moment later.
      assert.equal(existsSync(join(root, "stolen.txt")), false);
    });
  },
);

describe(
  "links to other sites",
  {
    skip: headless
      ? "needs a display"
      : !runtimePath
        ? "no runtime binary built"
        : false,
  },
  () => {
    let root;
    let child;
    let server;
    let away;
    let routed;
    const mail = "mailto:someone@example.com";
    /** Every path the other site was asked for - by a window that followed a link in place. */
    const visited = [];

    before(async () => {
      root = await mkdtemp(join(tmpdir(), "vantail-links-out-"));

      // The other site answers at once, so a link followed in place really
      // does take the window away - a dead address would leave the page
      // sitting there, and "stayed" would prove nothing.
      server = createServer((request, response) => {
        visited.push(request.url);
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>elsewhere</title>");
      });
      await new Promise((listening) =>
        server.listen(0, "127.0.0.1", listening),
      );
      const site = `http://127.0.0.1:${server.address().port}`;
      away = `${site}/away`;
      routed = `${site}/routed`;
      await cp(
        join(repoRoot, "packages", "api", "dist"),
        join(root, "dist", "api"),
        { recursive: true },
      );
      await writeFile(
        join(root, "vantail.json"),
        JSON.stringify({
          app: {
            name: "LinkOutTest",
            identifier: `dev.vantail.linkouttest.${process.pid}`,
            version: "1.0.0",
          },
          window: { width: 360, height: 240, visible: false },
          distDir: "dist",
          permissions: {
            filesystem: { read: [`${root}/**`], write: [`${root}/**`] },
          },
        }),
      );
      // Clicked from script: the bridge does not ask whether a person did
      // it, so what is checked here is exactly what a real click gets.
      await writeFile(
        join(root, "dist", "index.html"),
        `<!doctype html>
<meta charset="utf-8">
<a id="away" href="${away}">away</a>
<a id="routed" href="${routed}">routed</a>
<a id="mail" href="${mail}">mail</a>
<a id="next" href="next.html">next</a>
<script type="module">
import { invoke } from "./api/index.js";
const start = location.href;
// A router that handles its own links.
document.getElementById("routed").addEventListener("click", (event) => event.preventDefault());
for (const id of ["away", "routed", "mail"]) document.getElementById(id).click();
await new Promise((settle) => setTimeout(settle, 500));
await invoke("filesystem.writeText", {
  path: ${JSON.stringify(join(root, "report.json"))},
  contents: JSON.stringify({ stayed: location.href === start }),
});
document.getElementById("next").click();
</script>`,
      );
      await writeFile(
        join(root, "dist", "next.html"),
        `<!doctype html>
<meta charset="utf-8">
<script type="module">
import { invoke } from "./api/index.js";
await invoke("filesystem.writeText", {
  path: ${JSON.stringify(join(root, "arrived.txt"))},
  contents: location.pathname,
});
</script>`,
      );

      child = spawn(runtimePath, ["--config", join(root, "vantail.json")], {
        stdio: "ignore",
        env: { ...process.env, VANTAIL_OPEN_STUB: join(root, "opened.txt") },
      });
    });

    after(async () => {
      child?.kill("SIGKILL");
      server?.close();
      if (root && !process.env.VANTAIL_KEEP) {
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 250,
        }).catch(() => {});
      }
    });

    it("keeps the window on the application", async () => {
      const report = await until(
        "the page reporting back",
        () =>
          readFile(join(root, "report.json"), "utf8")
            .then(JSON.parse)
            .catch(() => undefined),
        (seen) => seen !== undefined,
      );
      assert.equal(report.stayed, true);
      assert.deepEqual(visited, [], "the window went to the other site");
    });

    it("hands a web page and a mail link to the system, and nothing a router handled", async () => {
      const opened = await until(
        "both links reaching the system",
        () =>
          readFile(join(root, "opened.txt"), "utf8")
            .then((text) => text.split(/\r?\n/).filter(Boolean))
            .catch(() => []),
        (lines) => lines.length >= 2,
      );
      assert.deepEqual(opened, [away, mail]);
    });

    it("still follows a link within the application", async () => {
      const arrived = await until(
        "the application's own link",
        () => readFile(join(root, "arrived.txt"), "utf8").catch(() => undefined),
        (contents) => contents !== undefined,
      );
      assert.equal(arrived, "/next.html");
    });
  },
);
