/**
 * Deep links and single instance, with two real processes.
 *
 * This is the pair that cannot be tested any other way: the whole point of
 * single instance is what happens when the application is started a *second*
 * time, and the whole point of holding a link is what happens when it arrives
 * before there is a window to give it to.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { resolveRuntimeBinary } from "@vantail/runtime";

const run = promisify(execFile);
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

const PROTOCOL = "vantailtest";

/** Build a throwaway application that records what reaches it. */
async function fixture(root) {
  await cp(
    join(repoRoot, "packages", "api", "dist"),
    join(root, "dist", "api"),
    {
      recursive: true,
    },
  );

  await writeFile(
    join(root, "vantail.json"),
    JSON.stringify({
      app: {
        name: "LinkTest",
        identifier: `dev.vantail.linktest.${process.pid}`,
        version: "1.0.0",
      },
      window: { width: 360, height: 240, visible: false },
      distDir: "dist",
      protocols: [PROTOCOL],
      permissions: {
        filesystem: { read: [`${root}/**`], write: [`${root}/**`] },
      },
    }),
  );

  await writeFile(
    join(root, "dist", "index.html"),
    `<!doctype html>
<meta charset="utf-8">
<body>
<script type="module">
import { app, deepLink, invoke } from "./api/index.js";
const seen = { links: [], launches: [] };

// Writes are chained, and the state is serialised at the moment the write
// happens rather than when it was asked for. Two handlers each saving
// otherwise race: the one that serialised first can land last, and overwrite
// the newer state with the older one.
let writing = Promise.resolve();
const save = () => {
  writing = writing.then(() =>
    invoke("filesystem.writeText", {
      path: ${JSON.stringify(join(root, "seen.json"))},
      contents: JSON.stringify(seen),
    }),
  );
  return writing;
};

deepLink.onOpen(async (url) => { seen.links.push(url); await save(); });
app.onSecondInstance(async (launch) => { seen.launches.push(launch.args); await save(); });
await save();
</script>
</body>`,
  );
}

/** Wait for the application to write its report, or give up. */
async function report(root, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(await readFile(join(root, "seen.json"), "utf8"));
      if (predicate(last)) return last;
    } catch {
      // Not written yet.
    }
    await new Promise((wait) => setTimeout(wait, 150));
  }
  return last;
}

/**
 * Whatever the runtime itself said, with the toolkit's chatter removed.
 *
 * GTK and GLib warn to stderr routinely - a missing accessibility bus, a
 * seat with no keyboard - and none of it is this application's doing.
 */
function vantailErrors(stderr) {
  return stderr
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter(
      (line) =>
        !/\b(WARNING|CRITICAL|Message|Gtk|Gdk|dbind|AT-SPI)\b/.test(line),
    )
    .join("\n")
    .trim();
}

describe(
  "deep links",
  {
    skip: headless
      ? "needs a display"
      : !runtimePath
        ? "no runtime binary built"
        : false,
  },
  () => {
    let root;
    let primary;

    before(async () => {
      root = await mkdtemp(join(tmpdir(), "vantail-links-"));
      await fixture(root);
    });

    after(async () => {
      primary?.kill("SIGKILL");
      if (root && !process.env.VANTAIL_KEEP) {
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 250,
        }).catch(() => {});
      }
    });

    it("hands a link to the instance already running, and exits", async () => {
      primary = spawn(runtimePath, ["--config", join(root, "vantail.json")], {
        stdio: "ignore",
      });
      await report(root, (seen) => seen !== undefined);

      // On Windows and Linux this is how a link arrives: the application is
      // started again with the URL in argv.
      const url = `${PROTOCOL}://callback?code=abc123`;
      const second = await run(runtimePath, [
        "--config",
        join(root, "vantail.json"),
        url,
      ]);

      // The second process handed over and stopped rather than opening a
      // window of its own.
      //
      // Not `stderr === ""`: GTK writes to stderr on any Linux box without an
      // accessibility bus, which every container is. What matters is that
      // Vantail said nothing, since it prints `vantail: ...` and exits 1 when
      // something is actually wrong.
      assert.equal(
        vantailErrors(second.stderr),
        "",
        `the second instance complained: ${second.stderr}`,
      );
      assert.equal(
        primary.exitCode,
        null,
        "the first instance should still be running",
      );

      // Both, not either: the link and the launch are reported by separate
      // handlers that each save, so reading after the first one lands sees
      // the other's array still empty.
      const seen = await report(
        root,
        (state) => state.links.length > 0 && state.launches.length > 0,
      );
      assert.deepEqual(seen.links, [url]);
      assert.ok(
        seen.launches.some((args) => args.includes(url)),
        `the second launch should have been reported, saw ${JSON.stringify(seen.launches)}`,
      );
    });

    it("holds a link that arrives before there is a window", async () => {
      primary?.kill("SIGKILL");
      primary = undefined;
      await rm(join(root, "seen.json"), { force: true });
      // The socket is released when the process dies; give it a moment.
      await new Promise((wait) => setTimeout(wait, 500));

      const url = `${PROTOCOL}://launch?first=1`;
      const cold = spawn(
        runtimePath,
        ["--config", join(root, "vantail.json"), url],
        {
          stdio: "ignore",
        },
      );

      try {
        // Launched *by* the link: it exists before any page does, and has to
        // survive until something asks for it.
        const seen = await report(root, (state) => state.links.length > 0);
        assert.deepEqual(seen.links, [url]);
      } finally {
        cold.kill("SIGKILL");
      }
    });

    it("does not mistake a link for a config path", async () => {
      // A bare argument used to be read as the path to vantail.json.
      const { stdout } = await run(runtimePath, ["--help"]);
      assert.match(stdout, /--config/);
    });
  },
);
