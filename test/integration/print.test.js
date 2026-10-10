/**
 * `print.document`, end to end.
 *
 * What this checks is the path the SDK and the runtime share: the arguments
 * are validated, a hidden view is built for caller-supplied content, that
 * content finishes loading, and the call comes back. What it deliberately
 * does not check is a person clicking Print - a test that stops for a human
 * is not a test.
 *
 * **The dialog is skipped with `VANTAIL_PRINT_STUB=1`.** The runtime reads
 * that variable in `api::print::run_print_dialog`: with it set, the hidden
 * view is still created and the content still loaded, but the modal native
 * dialog is not shown. That is the only thing stubbed, and it is why this can
 * run unattended at all.
 *
 * What is therefore *not* exercised here, and is checked by hand:
 *
 *   - the dialog itself, on all three platforms. The platform APIs
 *     (`ICoreWebView2_16::ShowPrintUI`, `WKWebView`'s print operation,
 *     `WebKitPrintOperation::run_dialog`) each block the event loop while
 *     they are open, so nothing inside this process can drive or observe
 *     them;
 *   - that the printed page looks right. `VANTAIL_KEEP=1` leaves the fixture
 *     on disk to check that by eye;
 *   - the hidden window is never on screen, which is by construction - it is
 *     built with `with_visible(false)` and never listed by `window.list`.
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

describe(
  "print.document",
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
      await cp(
        join(repoRoot, "packages", "api", "dist"),
        join(root, "dist", "api"),
        { recursive: true },
      );

      // A minimal but complete PDF: one page, one text object. It only has to
      // be something the webview will load, so that the `pdfPath` route goes
      // all the way through render completion like the `html` one.
      await writeFile(join(root, "dist", "invoice.pdf"), tinyPdf());

      await writeFile(
        join(root, "vantail.json"),
        JSON.stringify({
          app: {
            name: "PrintTest",
            identifier: "dev.vantail.printtest",
            version: "1.0.0",
          },
          window: { width: 480, height: 360, title: "PrintTest" },
          distDir: "dist",
          permissions: {
            // Printing needs no flag of its own. The PDF is a file being
            // read, so *it* needs the scope - which is the point of having
            // the read scope here at all.
            filesystem: {
              read: [`${root}/**`],
              write: [`${root}/**`],
            },
          },
        }),
      );

      await writeFile(
        join(root, "dist", "index.html"),
        fixture(join(root, "results.json"), join(root, "dist", "invoice.pdf")),
      );

      const output = await run(runtimePath, [
        "--config",
        join(root, "vantail.json"),
      ]);
      results = JSON.parse(await readFile(join(root, "results.json"), "utf8"));
      results.runtimeStderr = output.stderr;
      assert.equal(
        results.fatal,
        null,
        `the page under test failed: ${results.fatal}\ngot as far as: ${Object.keys(results).join(", ")}`,
      );
      assert.equal(
        results.finishedBecause,
        "script complete",
        `the page did not finish; it got as far as: ${Object.keys(results).join(", ")}\n` +
          `runtime said: ${results.runtimeStderr || "(nothing)"}`,
      );
    });

    after(async () => {
      // Set VANTAIL_KEEP=1 to leave the fixture on disk and poke at it.
      if (process.env.VANTAIL_KEEP) {
        console.log(`fixture kept at ${root}`);
        return;
      }
      // Windows holds a WebView2 lockfile briefly after the process exits, so
      // removal needs a few attempts - and a leftover temp directory is not
      // worth failing a suite over.
      if (root) {
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 250,
        }).catch(() => {});
      }
    });

    it("refuses both sources at once with INVALID_ARGUMENT", () => {
      assert.equal(results.bothCode, "INVALID_ARGUMENT");
      // Said before anything rendered, so no hidden view was ever built.
      assert.match(results.bothMessage, /html.*pdfPath|pdfPath.*html/);
    });

    it("refuses no source at all with INVALID_ARGUMENT", () => {
      assert.equal(results.neitherCode, "INVALID_ARGUMENT");
      assert.match(results.neitherMessage, /html|pdfPath/);
    });

    it("refuses an empty string rather than opening a dialog over nothing", () => {
      assert.equal(results.emptyCode, "INVALID_ARGUMENT");
    });

    it("accepts a valid HTML document and resolves when the dialog closes", () => {
      assert.equal(results.htmlCode, undefined, results.htmlMessage);
      assert.equal(results.htmlResolved, true);
    });

    it("accepts a PDF on disk inside the read scope", () => {
      assert.equal(results.pdfCode, undefined, results.pdfMessage);
      assert.equal(results.pdfResolved, true);
    });

    it("refuses a PDF outside the filesystem scope, as a read would", () => {
      // Printing a file reads it. Same scope, same refusal.
      assert.equal(results.outsidePdfCode, "PERMISSION_DENIED");
    });

    it("names no window, so the application's own UI cannot be printed", () => {
      // There is no argument-less call and no window argument: a call that
      // named neither source is refused (checked above), and the API surface
      // has nothing else to pass. This asserts the shape of the request the
      // SDK actually sent, so a future `window` option would show up here.
      assert.deepEqual(results.printRequestKeys, ["html"]);
    });

    it("leaves no print window behind", () => {
      // The hidden view is not an application window: it must never appear in
      // the list, and must be gone once the dialog has closed.
      assert.deepEqual(results.windowsAfter, ["main"]);
    });

    it("still answers about a window after printing", () => {
      // The print job tears down its own view and nothing else - a check that
      // the window manager was not left holding a stale entry.
      assert.equal(results.aliveAfter, "main");
    });
  },
);

/** The page under test: real SDK, real protocol, results written to disk. */
function fixture(resultsPath, pdfPath) {
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
  // The print jobs each open a hidden window and load content into it, so
  // this is generous - but a hang has to end in a report either way.
  setTimeout(function () { window.__finish("watchdog"); }, 30000);
</script>
<script type="module">
import {
  currentWindow, listWindows, print, VantailError,
} from "./api/index.js";

const results = window.__results;

/** Run a call that is expected to fail and record its code. */
const failure = async (key, promise) => {
  try {
    await promise;
    results[key + "Code"] = "UNEXPECTEDLY_SUCCEEDED";
  } catch (error) {
    results[key + "Code"] = VantailError.is(error) ? error.code : "NOT_A_VANTAIL_ERROR";
    results[key + "Message"] = String(error && error.message);
  }
};

try {
  const html = "<!doctype html><html><body><h1>Invoice INV-1042</h1>" +
    "<table><tr><td>Sketchbook</td><td>$36.00</td></tr></table></body></html>";

  // Both, neither, and an empty string: all rejected before anything renders.
  await failure("both", print.document({ html, pdfPath: ${JSON.stringify(pdfPath)} }));
  await failure("neither", print.document({}));
  await failure("empty", print.document({ html: "" }));

  // A file outside the scope, refused exactly as filesystem.readText would.
  await failure("outsidePdf", print.document({ pdfPath: "/etc/hosts" }));

  // The happy path. What the SDK put on the wire is captured so the test can
  // assert that no window was named - that is the safety property, and it is
  // cheaper to check here than to prove by absence.
  const originalPost = window.__VANTAIL__.postMessage;
  let captured = null;
  window.__VANTAIL__.postMessage = function (message) {
    if (message && message.method === "print.document") captured = message;
    return originalPost.call(this, message);
  };

  try {
    await print.document({ html });
    results.htmlResolved = true;
  } catch (error) {
    results.htmlCode = VantailError.is(error) ? error.code : "NOT_A_VANTAIL_ERROR";
    results.htmlMessage = String(error && error.message);
  }
  results.printRequestKeys = captured ? Object.keys(captured.params).sort() : null;

  try {
    await print.document({ pdfPath: ${JSON.stringify(pdfPath)} });
    results.pdfResolved = true;
  } catch (error) {
    results.pdfCode = VantailError.is(error) ? error.code : "NOT_A_VANTAIL_ERROR";
    results.pdfMessage = String(error && error.message);
  }

  window.__VANTAIL__.postMessage = originalPost;

  // The hidden views are not windows: none of them is listed, and none is
  // left over now that the dialogs have closed.
  results.windowsAfter = await listWindows();
  results.aliveAfter = currentWindow();
} catch (error) {
  results.fatal = String(error && error.stack ? error.stack : error);
}

window.__finish("script complete");
</script>
</body>`;
}

/** A one-page PDF, built here rather than checked in as a binary fixture. */
function tinyPdf() {
  const content =
    "BT /F1 24 Tf 72 700 Td (Invoice INV-1042) Tj ET\n" +
    "BT /F1 12 Tf 72 670 Td (Total  $70.50) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // The one stub: the hidden view is still built and the content still
      // loaded, and only the modal dialog is skipped.
      env: { ...process.env, VANTAIL_PRINT_STUB: "1" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`runtime did not finish in time\n${stderr}`));
    }, 90_000);

    child.once("error", reject);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0) return resolvePromise({ stderr });
      reject(new Error(`runtime exited with ${exitCode}\n${stderr}`));
    });
  });
}