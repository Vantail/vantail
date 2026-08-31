/**
 * What a window is the size of, and what shape it is, once the platform has
 * had its say.
 *
 * Both of these are Windows stories with a cross-platform assertion. The
 * application menu there is a real menu bar hung off every window, and a menu
 * bar takes its height out of the client area: a window that has one opened
 * shorter than it asked for, and every call that put a size limit back - which
 * maximise and restore both do - handed back a client area one menu bar taller
 * than the one it was given, so a window grew by 20px a cycle. Nothing about
 * either is visible from the outside except the size, which is what this
 * measures.
 *
 * It needs a display, so it skips itself where there is not one.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { resolveRuntimeBinary } from "@vantail/runtime";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Linux is skipped by default for the same reason as the rest of the suite:
// these open real windows, and WebKitGTK under Xvfb is not something this
// project has verified.
const headless =
  process.env.VANTAIL_SKIP_INTEGRATION === "1" ||
  (process.platform === "linux" &&
    process.env.VANTAIL_FORCE_INTEGRATION !== "1");

let runtimePath;
try {
  runtimePath = resolveRuntimeBinary({ cwd: repoRoot }).path;
} catch {
  runtimePath = undefined;
}

/** What the config asks for, and what the window has to still be at the end. */
const OPENED = { width: 600, height: 400 };
/** The floor the config sets, which has to survive a maximise. */
const MINIMUM = { width: 400, height: 300 };
/** The second window, created after the menu was installed. */
const CREATED = { width: 500, height: 320 };

describe(
  "window size and shape",
  {
    skip: headless
      ? "needs a display"
      : !runtimePath
        ? "no runtime binary built"
        : false,
  },
  () => {
    let root;
    let results;

    before(async () => {
      root = await mkdtemp(join(tmpdir(), "vantail-window-shape-"));
      await cp(
        join(repoRoot, "packages", "api", "dist"),
        join(root, "dist", "api"),
        { recursive: true },
      );

      await writeFile(
        join(root, "vantail.json"),
        JSON.stringify({
          app: {
            name: "Shape",
            identifier: "dev.vantail.shape",
            version: "1.0.0",
          },
          window: {
            title: "Shape",
            ...OPENED,
            minWidth: MINIMUM.width,
            minHeight: MINIMUM.height,
            // No frame and a corner shape of its own: the combination the
            // runtime draws itself rather than leaving to the platform.
            decorations: false,
            borderRadius: { topLeft: 16, bottomRight: 8 },
          },
          // A menu is the whole point: without one, none of this went wrong.
          menu: [
            {
              type: "submenu",
              label: "File",
              items: [{ type: "normal", id: "new", label: "New" }],
            },
            {
              type: "submenu",
              label: "Help",
              items: [{ type: "normal", id: "about", label: "About" }],
            },
          ],
          distDir: "dist",
          permissions: {
            window: true,
            menu: true,
            filesystem: { read: [`${root}/**`], write: [`${root}/**`] },
          },
        }),
      );

      await writeFile(join(root, "dist", "second.html"), "<!doctype html><body>");
      await writeFile(
        join(root, "dist", "index.html"),
        fixture(join(root, "results.json")),
      );

      const output = await run(runtimePath, [
        "--config",
        join(root, "vantail.json"),
      ]);
      results = JSON.parse(await readFile(join(root, "results.json"), "utf8"));
      assert.equal(
        results.fatal,
        null,
        `the page under test failed: ${results.fatal}\nruntime said: ${output.stderr || "(nothing)"}`,
      );
    });

    after(async () => {
      if (process.env.VANTAIL_KEEP) {
        console.log(`fixture kept at ${root}`);
        return;
      }
      // Windows holds a WebView2 lockfile briefly after the process exits.
      if (root) {
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 250,
        }).catch(() => {});
      }
    });

    it("opens the window at the size the config asked for", () => {
      assert.deepEqual(round(results.opened), OPENED);
    });

    it("opens a window created after the menu at the size it asked for", () => {
      assert.deepEqual(round(results.created), CREATED);
    });

    it("leaves the window the size it was after maximise and restore", () => {
      // Once was enough to see it; three times is what made it obvious.
      for (const [index, size] of results.restored.entries()) {
        assert.deepEqual(
          round(size),
          OPENED,
          `cycle ${index + 1} restored to ${size.width}x${size.height}`,
        );
      }
    });

    it("is the same size after hiding the title bar and showing it again", () => {
      assert.deepEqual(round(results.toggled), CREATED);
    });

    it("fills the screen when maximised", () => {
      for (const size of results.maximized) {
        assert.ok(
          size.width > OPENED.width && size.height > OPENED.height,
          `maximised to ${size.width}x${size.height}, which is not bigger than it was`,
        );
      }
    });

  },
);

/** Sizes come back as floats; nothing here cares about a sub-pixel. */
function round({ width, height }) {
  return { width: Math.round(width), height: Math.round(height) };
}

function fixture(resultsPath) {
  return `<!doctype html>
<meta charset="utf-8">
<title>shape</title>
<body>
<script>
  // A module that fails to parse never runs its own error handling, so the
  // page always has something to report even then.
  window.__results = { fatal: null };
  window.__finish = function (reason) {
    if (window.__finished) return;
    window.__finished = true;
    window.__results.finishedBecause = reason;
    window.__VANTAIL__.postMessage({
      id: "report",
      method: "filesystem.writeText",
      params: { path: ${JSON.stringify(resultsPath)}, contents: JSON.stringify(window.__results, null, 2) },
    });
    setTimeout(function () {
      window.__VANTAIL__.postMessage({ id: "quit", method: "app.quit" });
    }, 250);
  };
  addEventListener("error", function (event) {
    window.__results.fatal = (event.message || "error") + " @ " + (event.filename || "?") + ":" + (event.lineno || 0);
    window.__finish("error");
  });
  addEventListener("unhandledrejection", function (event) {
    window.__results.fatal = "unhandled rejection: " + String((event.reason && event.reason.stack) || event.reason);
    window.__finish("rejection");
  });
  setTimeout(function () { window.__finish("watchdog"); }, 20000);
</script>
<script type="module">
import { appWindow, createWindow, getWindow } from "./api/index.js";

const results = window.__results;
const settle = () => new Promise((done) => setTimeout(done, 250));

results.opened = await appWindow.size();

results.maximized = [];
results.restored = [];
for (let i = 0; i < 3; i++) {
  await appWindow.maximize();
  await settle();
  results.maximized.push(await appWindow.size());
  await appWindow.unmaximize();
  await settle();
  results.restored.push(await appWindow.size());
}

// A window created after the menu was installed is told about the menu as it
// opens, which is the other place a menu bar can eat into what was asked for.
await createWindow("second", { url: "second.html", ...${JSON.stringify(CREATED)} });
await settle();
const second = getWindow("second");
results.created = await second.size();

// Hiding the title bar and showing it again takes the frame - and the menu
// bar in it - away and puts it back. The page should be no bigger or smaller
// for the round trip.
for (let i = 0; i < 2; i++) {
  await second.setTitleBarStyle("hidden");
  await settle();
  await second.setTitleBarStyle("default");
  await settle();
}
results.toggled = await second.size();

window.__finish("script complete");
</script>
</body>`;
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`runtime did not finish in time\n${stderr}`));
    }, 60_000);

    child.once("error", reject);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({ exitCode, stderr });
    });
  });
}
