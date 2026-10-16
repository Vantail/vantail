/**
 * `print.document`, end to end against the real runtime.
 *
 * Boots the runtime with a real (hidden-capable) window, loads the real
 * `@vantail/api` build, and drives `print.document` through validation, the
 * filesystem scope check for `pdfPath`, and - under `VANTAIL_PRINT_STUB=1` -
 * the hidden-view render path up to the native dialog.
 *
 * The stub renders but skips the dialog and answers `{ printed: false }`.
 * That is deliberate, and the one thing this suite cannot do by construction:
 * the platform print APIs (`ShowPrintUI` on Windows, `NSPrintOperation` on
 * macOS, `WebKitPrintOperation` on Linux) open a modal system dialog that
 * needs a person to choose a printer or cancel. There is no printer in CI
 * and no person either, so the dialog interaction itself is not exercised
 * here - what is exercised is everything up to it (argument validation, the
 * IPC round trip, the read-scope check, and the render-then-answer path),
 * which is also where this project's own logic lives. The dialog calls are
 * checked by looking at the screen instead, like `dialog.message`.
 *
 * It needs a display, so it skips itself where there is not one.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { resolveRuntimeBinary } from "@vantail/runtime";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Linux is skipped by default: these open real windows, and WebKitGTK under
// Xvfb is not something this project has verified. Set VANTAIL_FORCE_INTEGRATION
// to try it anyway.
const headless =
  process.env.VANTAIL_SKIP_INTEGRATION === "1" ||
  (process.platform === "linux" && process.env.VANTAIL_FORCE_INTEGRATION !== "1");
let runtimePath;
try {
  runtimePath = resolveRuntimeBinary({ cwd: repoRoot }).path;
} catch {
  runtimePath = undefined;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

describe(
  "native printing",
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
      root = await mkdtemp(join(tmpdir(), "vantail-print-"));
      await cp(join(repoRoot, "packages", "api", "dist"), join(root, "dist", "api"), {
        recursive: true,
      });

      // Something printable inside the scope, and nothing about it special:
      // the runtime checks that the path is a file, not that it is a PDF.
      const printable = join(root, "invoice.pdf");
      await writeFile(printable, "%PDF-1.4\n% a stand-in for the stub run\n");

      const resultsPath = join(root, "results.json");
      await writeFile(
        join(root, "vantail.json"),
        JSON.stringify({
          app: {
            name: "PrintTest",
            identifier: "dev.vantail.printtest",
            version: "1.0.0",
          },
          window: { width: 480, height: 320 },
          distDir: "dist",
          permissions: {
            // Deliberately narrow: the printable file is inside, /etc is not.
            filesystem: { read: [`${root}/**`], write: [`${root}/**`] },
          },
        }),
      );

      await writeFile(join(root, "dist", "index.html"), fixture(printable, resultsPath));

      // Renders, but the dialog is skipped: CI has no printer and no person.
      const child = spawn(runtimePath, ["--config", join(root, "vantail.json")], {
        env: { ...process.env, VANTAIL_PRINT_STUB: "1" },
        stdio: "ignore",
      });
      try {
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          if (existsSync(resultsPath)) break;
          await wait(200);
        }
        assert.ok(existsSync(resultsPath), "the application never reported back");
        results = JSON.parse(await readFile(resultsPath, "utf8"));
      } finally {
        child.kill("SIGKILL");
      }

      assert.equal(
        results.fatal,
        null,
        `the page under test failed: ${results.fatal}`,
      );
      assert.equal(results.finishedBecause, "script complete");
    });

    after(async () => {
      if (root && !process.env.VANTAIL_KEEP) {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(
          () => {},
        );
      }
    });

    it("rejects when neither source is given", () => {
      assert.equal(results.neitherCode, "INVALID_ARGUMENT");
    });

    it("rejects raw calls too, on the native side", () => {
      // The SDK validates first, so this bypasses it: the runtime must
      // refuse on its own rather than trusting the caller.
      assert.equal(results.rawNeitherCode, "INVALID_ARGUMENT");
    });

    it("rejects when both sources are given", () => {
      assert.equal(results.bothCode, "INVALID_ARGUMENT");
    });

    it("renders HTML and answers without a human at the dialog", () => {
      // Under the stub the dialog is skipped, so `printed` is false - the
      // point is that the call travelled the whole IPC and render path and
      // answered instead of hanging or throwing.
      assert.deepEqual(results.htmlPrinted, { printed: false });
    });

    it("reads a PDF path inside the scope", () => {
      assert.deepEqual(results.pdfPrinted, { printed: false });
    });

    it("refuses a PDF path outside the scope", () => {
      assert.equal(results.outsideCode, "PERMISSION_DENIED");
    });

    it("reports a missing PDF file", () => {
      assert.equal(results.missingCode, "NOT_FOUND");
    });

    it("rejects a call with no argument at all", () => {
      // Must reject with INVALID_ARGUMENT, not throw a TypeError.
      assert.equal(results.noArgCode, "INVALID_ARGUMENT");
    });

    it("rejects empty strings on the native side", () => {
      // The SDK filters these first, so raw calls prove the runtime does too.
      assert.equal(results.rawEmptyCode, "INVALID_ARGUMENT");
      assert.equal(results.rawBothEmptyCode, "INVALID_ARGUMENT");
    });

    it("rejects a mistyped source as a shape error, not a choice error", () => {
      // `{ html: 123 }` never reaches validation: deserialization fails with
      // INVALID_PARAMS. The two codes answer different questions.
      assert.equal(results.rawWrongTypeCode, "INVALID_PARAMS");
    });

    it("ignores unknown fields beside a valid source", () => {
      assert.deepEqual(results.rawExtraFieldPrinted, { printed: false });
    });

    it("treats whitespace-only html as content", () => {
      assert.deepEqual(results.blankPrinted, { printed: false });
    });
  },
);

/** The page under test: real SDK, real protocol, results written to disk. */
function fixture(printable, resultsPath) {
  return `<!doctype html>
<meta charset="utf-8">
<title>print</title>
<body>
<script>
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
import { invoke, print, VantailError } from "./api/index.js";

const results = window.__results;
const codeOf = async (promise) => {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return VantailError.is(error) ? error.code : "not-a-vantail-error";
  }
};

results.neitherCode = await codeOf(print.document({}));
results.rawNeitherCode = await codeOf(invoke("print.document", {}));
results.bothCode = await codeOf(print.document({ html: "<h1>hi</h1>", pdfPath: ${JSON.stringify(printable)} }));
results.noArgCode = await codeOf(print.document());
results.rawEmptyCode = await codeOf(invoke("print.document", { html: "" }));
results.rawBothEmptyCode = await codeOf(invoke("print.document", { html: "", pdfPath: "" }));
results.rawWrongTypeCode = await codeOf(invoke("print.document", { html: 123 }));
results.rawExtraFieldPrinted = await invoke("print.document", { html: "<p>extra fields are fine</p>", copies: 2 });
results.blankPrinted = await print.document({ html: "   " });
results.htmlPrinted = await print.document({ html: "<h1>Invoice INV-2049</h1><p>$60.50</p>" });
results.pdfPrinted = await print.document({ pdfPath: ${JSON.stringify(printable)} });
results.outsideCode = await codeOf(print.document({ pdfPath: "/etc/hostname" }));
results.missingCode = await codeOf(print.document({ pdfPath: ${JSON.stringify(printable + ".missing")} }));

window.__finish("script complete");
</script>
</body>`;
}
