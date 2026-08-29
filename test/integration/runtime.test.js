/**
 * The contract, end to end.
 *
 * Boots the real runtime with a real window, loads the real `@vantail/api`
 * build over the `vantail://` protocol, drives a script of calls, and checks
 * what came back. This is the test that would catch the SDK and the runtime
 * drifting apart - everything else only checks one side.
 *
 * It needs a display, so it skips itself where there is not one.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { resolveRuntimeBinary } from "@vantail/runtime";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where a login item for this fixture would land, per platform. */
const autostartEntry =
  process.platform === "darwin"
    ? join(homedir(), "Library/LaunchAgents/dev.vantail.integration.plist")
    : join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "autostart/dev.vantail.integration.desktop",
      );

// Linux is skipped by default: these open real windows, and WebKitGTK under
// Xvfb is not something this project has verified. Set VANTAIL_FORCE_INTEGRATION
// to try it anyway.
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
  "runtime and SDK",
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
    let device;

    before(async () => {
      // Stands in for a device on the LAN: it answers, and like a smart-home hub
      // or an smart light it sends no CORS headers whatsoever.
      device = createServer((request, response) => {
        if (request.url === "/redirect-away") {
          response.writeHead(302, {
            location: "http://192.168.99.99/elsewhere",
          });
          return response.end();
        }
        if (request.url === "/hop") {
          // A redirect that stays inside the allow list, so the chain is
          // followed rather than refused.
          response.writeHead(302, { location: "/status" });
          return response.end();
        }
        if (request.url === "/cookies") {
          // Two Set-Cookie headers, the first with a comma and a space inside
          // its own Expires date. Joining them cannot be undone.
          response.writeHead(200, {
            "content-type": "text/plain",
            "set-cookie": [
              "session=abc; Expires=Wed, 09 Jun 2027 10:18:14 GMT",
              "theme=dark; Path=/",
            ],
          });
          return response.end("ok");
        }
        if (request.url === "/stream") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          // Two writes with a gap, so they arrive as separate chunks the way
          // server-sent events do.
          response.write("data: one\n\n");
          setTimeout(() => {
            response.write("data: caf\u00e9\n\n");
            response.end();
          }, 30);
          return;
        }
        if (request.url === "/forever") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const tick = setInterval(() => response.write("data: tick\n\n"), 25);
          // A safety net: nothing should leave this open, but a suite must
          // not hang if something does.
          const stop = setTimeout(() => {
            clearInterval(tick);
            response.end();
          }, 5000);
          request.on("close", () => {
            clearInterval(tick);
            clearTimeout(stop);
          });
          return;
        }
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("device says hello");
      });
      // A real WebSocket endpoint, framed by hand: the handshake and the two
      // frame shapes this exercises are small, and a dev dependency for a
      // single test is not worth it.
      device.on("upgrade", (request, socket) => {
        const key = request.headers["sec-websocket-key"];
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");

        // Only ever offered "chat, other" by this test; picking the second
        // proves the client reports what the server actually chose.
        const offered = (request.headers["sec-websocket-protocol"] ?? "")
          .split(",")
          .map((name) => name.trim());
        const chosen = offered.includes("other") ? "other" : undefined;

        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            ...(chosen ? [`Sec-WebSocket-Protocol: ${chosen}`] : []),
            "\r\n",
          ].join("\r\n"),
        );

        // The header the webview's own WebSocket cannot send, echoed back so
        // the test can prove it arrived.
        socket.write(wsFrame(`auth:${request.headers.authorization}`, 0x1));

        let buffered = Buffer.alloc(0);
        socket.on("data", (incoming) => {
          buffered = Buffer.concat([buffered, incoming]);
          const { frames, rest } = wsParse(buffered);
          buffered = rest;
          for (const { opcode, payload } of frames) {
            if (opcode === 0x1) {
              socket.write(wsFrame(`echo:${payload.toString("utf8")}`, 0x1));
            } else if (opcode === 0x2) {
              socket.write(wsFrame(Buffer.from([...payload].reverse()), 0x2));
            } else if (opcode === 0x8) {
              // Echo the close frame back and hang up, as a server should.
              socket.write(wsFrame(payload, 0x8));
              socket.end();
            }
          }
        });
        socket.on("error", () => {});
      });

      await new Promise((ready) => device.listen(0, "127.0.0.1", ready));
      const devicePort = device.address().port;

      root = await mkdtemp(join(tmpdir(), "vantail-integration-"));
      await cp(
        join(repoRoot, "packages", "api", "dist"),
        join(root, "dist", "api"),
        {
          recursive: true,
        },
      );

      const scratch = join(root, "scratch");
      await writeFile(
        join(root, "vantail.json"),
        JSON.stringify({
          app: {
            name: "Integration",
            identifier: "dev.vantail.integration",
            version: "4.5.6",
          },
          window: { width: 640, height: 480, title: "Integration" },
          distDir: "dist",
          permissions: {
            clipboard: true,
            menu: true,
            tray: true,
            secrets: true,
            database: true,
            shortcut: true,
            autostart: true,
            // A vendor id nothing on any machine will have, so the filter is
            // observable: the list has to come back empty rather than full.
            hid: [{ vendorId: 0x0001 }],
            mdns: ["_vantailtest._tcp.local"],
            // The whole fixture directory, so the page can also write its
            // report. Everything outside it - including /etc - stays denied.
            filesystem: { read: [`${root}/**`], write: [`${root}/**`] },
            // Node itself: the only program guaranteed to be on every machine
            // this suite runs on. `/bin/echo` is not one of them.
            shell: {
              allow: [
                {
                  program: process.execPath,
                  args: ["-e", "process.stdout.write('hello')"],
                },
              ],
            },
            network: { allow: [`http://127.0.0.1:${devicePort}`] },
          },
        }),
      );
      await writeFile(join(root, "dist", "icon.png"), tinyPng());
      await writeFile(join(root, "dist", "second.html"), secondWindow());
      await writeFile(
        join(root, "dist", "index.html"),
        fixture(scratch, join(root, "results.json"), devicePort),
      );

      const output = await run(runtimePath, [
        "--config",
        join(root, "vantail.json"),
      ]);
      results = JSON.parse(await readFile(join(root, "results.json"), "utf8"));
      results.runtimeStderr = output.stderr;
      // A hang or a throw shows up here with everything the page did manage
      // to record, which is far more useful than a bare timeout.
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
      // A cancelled stream may still hold its connection, and `close` waits
      // for connections rather than cutting them.
      device?.closeAllConnections?.();
      device?.close();
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

    it("injects app identity before any application code runs", () => {
      assert.deepEqual(results.infoSync, {
        name: "Integration",
        version: "4.5.6",
        identifier: "dev.vantail.integration",
        isDev: false,
      });
      assert.equal(results.isVantail, true);
      assert.match(results.runtimeVersion, /^\d+\.\d+\.\d+/);
    });

    it("round-trips a call through the native side", async () => {
      assert.equal(results.appInfo.version, "4.5.6");
      // Vantail reports "macos" | "windows" | "linux"; Node spells two of
      // those differently.
      const expected =
        { darwin: "macos", win32: "windows" }[process.platform] ??
        process.platform;
      assert.equal(results.platform, expected);
    });

    it("writes and reads a file inside the permitted scope", () => {
      assert.equal(results.written, null);
      assert.equal(results.read, "hello ünicode   line");
      assert.equal(results.exists, true);
      assert.equal(results.statIsFile, true);
    });

    it("lists a directory with directories first", () => {
      assert.deepEqual(
        results.readDir.map((entry) => entry.name),
        ["nested", "note.txt"],
      );
      assert.equal(results.readDir[0].isDirectory, true);
      assert.equal(results.readDir[1].isFile, true);
    });

    it("refuses a path outside the scope, with a matchable code", () => {
      assert.equal(results.deniedCode, "PERMISSION_DENIED");
      assert.match(results.deniedMessage, /filesystem\.read/);
    });

    it("refuses a traversal that would escape the scope", () => {
      assert.equal(results.traversalCode, "PERMISSION_DENIED");
    });

    it("reports an unknown method rather than hanging", () => {
      assert.equal(results.unknownCode, "UNKNOWN_METHOD");
    });

    it("validates params on the native side", () => {
      assert.equal(results.badParamsCode, "INVALID_PARAMS");
    });

    it("denies a capability the config never asked for", () => {
      assert.equal(results.notificationCode, "PERMISSION_DENIED");
    });

    it("applies window changes and reports them back", () => {
      assert.deepEqual(results.size, { width: 640, height: 480 });
      assert.equal(results.titleAfterSet, "Renamed");
      assert.deepEqual(results.sizeAfterSet, { width: 700, height: 500 });
    });

    it("delivers window events to listeners", () => {
      // Window events name the window they happened to, since an app can have
      // several and they all reach the same listener API.
      assert.deepEqual(results.resizeEvent, {
        width: 700,
        height: 500,
        label: "main",
      });
    });

    it("opens a second window and lists both", () => {
      assert.deepEqual(results.windowsBefore, ["main"]);
      assert.deepEqual(results.windowsAfter, ["main", "second"]);
      assert.equal(results.secondTitle, "Second");
      assert.equal(results.currentLabel, "main");
    });

    it("passes application events between windows", () => {
      // There is no shared memory between webviews, so this is a full round
      // trip out through the runtime and back into the other window.
      assert.deepEqual(results.pong, { seenBy: "second", note: "hello" });
    });

    it("refuses a duplicate window label", () => {
      assert.equal(results.duplicateLabelCode, "ALREADY_EXISTS");
      assert.equal(results.badLabelCode, "INVALID_PARAMS");
    });

    it("closes a window and tells the others", () => {
      assert.equal(results.closed, true);
      assert.deepEqual(results.windowsAfterClose, ["main"]);
      assert.deepEqual(results.closeEvent, { label: "second" });
    });

    it("installs a menu and toggles a checkbox in it", () => {
      assert.equal(results.checkedBefore, true);
      assert.equal(results.checkedAfter, false);
      assert.equal(results.notACheckboxCode, "INVALID_PARAMS");
    });

    it("leaves out an item it cannot build rather than the whole menu", () => {
      // The failure this replaces: one bad accelerator dropped the entire
      // menu, and on macOS that is Cmd-Q, Cmd-C and Cmd-V gone with it.
      assert.equal(results.skipped.length, 1);
      assert.match(results.skipped[0], /Bad/);
      assert.match(results.skipped[0], /Nonsense/);

      // Everything beside it was installed and is still addressable.
      assert.equal(results.goodItemSurvived, true);
      assert.equal(results.checkboxSurvivedSkip, true);
      assert.equal(results.skippedItemIsGone, "NOT_FOUND");
    });

    it("accepts Return as the name of the Enter key", () => {
      assert.deepEqual(results.returnSkipped, []);
    });

    it("creates a tray icon from a PNG", () => {
      assert.equal(results.trayExists, true);
      assert.equal(results.missingIconCode, "NOT_FOUND");
    });

    it("runs an allowed program and refuses the rest", () => {
      assert.equal(results.echo.stdout, "hello");
      assert.equal(results.echo.success, true);
      assert.equal(results.deniedProgramCode, "PERMISSION_DENIED");
      assert.equal(results.deniedArgsCode, "PERMISSION_DENIED");
      assert.equal(results.shellOpenCode, "PERMISSION_DENIED");
    });

    it("round-trips binary data through base64", () => {
      // The PNG magic number, intact after read -> base64 -> write -> read.
      assert.deepEqual(results.pngHead, [137, 80, 78, 71]);
      assert.equal(results.pngCopyMatches, true);
    });

    it("reaches a device the webview cannot", () => {
      // The whole justification for a native HTTP client, asserted rather
      // than assumed: fetch cannot read this response, and network.request can.
      assert.equal(
        results.fetchFailed,
        true,
        "fetch unexpectedly succeeded without CORS headers",
      );
      assert.equal(results.networkStatus, 200);
      assert.equal(results.networkBody, "device says hello");
    });

    it("holds the network permission line, including across a redirect", () => {
      assert.equal(results.networkDeniedCode, "PERMISSION_DENIED");
      // A permitted host that redirects to a denied one is otherwise a way
      // straight through the fence.
      assert.equal(results.networkRedirectCode, "PERMISSION_DENIED");
    });

    it("keeps repeated headers apart even when joining them cannot", () => {
      assert.deepEqual(results.cookiePairs, [
        "session=abc; Expires=Wed, 09 Jun 2027 10:18:14 GMT",
        "theme=dark; Path=/",
      ]);
      // The record form joins them, and the Expires date has a comma and a
      // space of its own - so splitting it back apart would find three.
      assert.equal(results.cookieJoined.split(", ").length, 3);
      assert.equal(results.cookieBytes, 2);
      assert.ok(results.cookieTiming.totalMs >= 0);
      assert.ok(results.cookieTiming.totalMs >= results.cookieTiming.downloadMs);
    });

    it("records the redirects it followed", () => {
      assert.equal(results.hopStatus, 200);
      assert.equal(results.hopRedirects.length, 1);
      assert.equal(results.hopRedirects[0].status, 302);
      assert.equal(results.hopRedirects[0].location, "/status");
      // Same host, so nothing had to be dropped.
      assert.deepEqual(results.hopRedirects[0].droppedHeaders, []);
    });

    it("delivers a response as it arrives", () => {
      assert.equal(results.streamStatus, 200);
      assert.equal(results.streamContentType, "text/event-stream");
      // Both events, with the accented character intact across whatever
      // chunk boundary the two writes produced.
      assert.equal(results.streamText, "data: one\n\ndata: caf\u00e9\n\n");
      assert.deepEqual(results.streamEnd, { cancelled: false });
    });

    it("stops a stream that would otherwise never end", () => {
      assert.equal(results.foreverCancelled, true);
      assert.equal(results.foreverEnd.cancelled, true);
      assert.equal(results.foreverEnd.error, undefined);
      // Cancelling a stream that is already gone says so rather than throwing.
      assert.equal(results.foreverCancelAgain, false);
    });

    it("switches a live window between its own title bar and the platform's", () => {
      // It starts with the platform's, so there is nothing reserved.
      assert.equal(results.toggleBefore.style, "default");
      assert.equal(results.toggleBefore.css, "0px");

      // Hidden: a real height, and the page told about it in both forms.
      assert.equal(results.toggleHidden.style, "hidden");
      assert.ok(
        results.toggleHiddenMetrics.height > 0,
        `expected a real height, got ${results.toggleHiddenMetrics.height}`,
      );
      assert.equal(
        results.toggleHidden.css,
        `${results.toggleHiddenMetrics.height}px`,
        "the CSS variable has to follow the switch, or a toolbar sized from it goes stale",
      );
      assert.equal(
        results.toggleHidden.sync.height,
        results.toggleHiddenMetrics.height,
        "titleBarMetrics() has to agree with what the call returned",
      );

      // And back, with the reservation released.
      assert.equal(results.toggleBack.style, "default");
      assert.equal(results.toggleBack.css, "0px");
      assert.equal(results.toggleBack.sync.height, 0);
      assert.equal(results.toggleBackMetrics.height, 0);
    });

    it("takes a height of its own, and gives it back", () => {
      // Defaults to the platform's, which is what makes a custom bar read as
      // a title bar rather than as a div.
      assert.ok(results.nativeHeight > 0);
      assert.notEqual(results.nativeHeight, 48);

      // Asking for more room than the plain bar has gets a taller bar.
      assert.ok(
        results.tallMetrics.height > results.nativeHeight,
        `expected taller than ${results.nativeHeight}, got ${results.tallMetrics.height}`,
      );

      // Exactly what was asked for, on every platform. The window buttons are
      // centred in the bar by arithmetic rather than by asking macOS for one
      // of its own title bars, so there is no set of heights to round to.
      assert.equal(results.tallMetrics.height, 48);
      assert.equal(results.ceilingMetrics.height, 4000);

      // Where the window buttons sit down the bar, which is what a taller one
      // needs to line anything up with them. Reported because it cannot be
      // worked out: the platform does not always centre them.
      if (process.platform === "darwin") {
        assert.ok(
          results.tallMetrics.buttonHeight > 0,
          "macOS keeps its window buttons, so their size should be reported",
        );
        assert.ok(
          results.tallMetrics.buttonTop > 0,
          "macOS leaves a gap above its window buttons; 0 means it was not measured",
        );
        assert.ok(
          results.tallMetrics.buttonTop + results.tallMetrics.buttonHeight <=
            results.tallMetrics.height,
          `buttons at ${results.tallMetrics.buttonTop}+${results.tallMetrics.buttonHeight} do not fit a bar of ${results.tallMetrics.height}`,
        );
      } else {
        // Nowhere else keeps them once the title bar is gone.
        assert.equal(results.tallMetrics.buttonTop, 0);
        assert.equal(results.tallMetrics.buttonHeight, 0);
      }

      // Whatever that height came to, everywhere the page can read it agrees.
      assert.equal(results.tallCss, `${results.tallMetrics.height}px`);
      assert.equal(results.tallSync.height, results.tallMetrics.height);

      // `null` puts the platform's own bar back, height and inset both - the
      // taller bar starts its buttons a little further in, so this is not the
      // same number as the tall one reported.
      assert.equal(results.backToNative.height, results.nativeHeight);
      assert.equal(results.backToNative.insetLeft, results.nativeInsetLeft);

      // Placing the lights by hand and re-centring both answer with the
      // metrics, and neither changes the bar they are being placed in.
      const tall = results.tallMetrics.height;
      if (process.platform === "darwin") {
        assert.equal(results.movedLights.moved, true);
        assert.equal(results.movedLights.height, tall);
      } else {
        // Refused, and said why - rather than pretending it moved something
        // that is not there.
        assert.equal(results.movedLights.moved, false);
        assert.equal(results.movedLights.code, "UNSUPPORTED");
      }
      assert.equal(results.centredLights.height, tall);
    });

    it("reports no title bar to reserve when there is a title bar", () => {
      // This window is an ordinary one, so there is nothing to leave room
      // for and the numbers say so rather than being absent.
      assert.deepEqual(results.mainTitleBar, {
        height: 0,
        insetLeft: 0,
        insetRight: 0,
        // Nothing is being drawn up there by the application, so there is
        // nothing to line up with the window buttons either.
        buttonTop: 0,
        buttonHeight: 0,
      });
      // And the CSS variable is set either way, so `var()` never falls back.
      assert.equal(results.mainTitleBarCss, "0px");
    });

    it("opens a window with no title bar for the app to draw over", () => {
      assert.equal(results.bareFatal, undefined, results.bareFatal);
      assert.equal(results.bareExists, true);
      // The window is a real one: hiding the bar is not hiding the window.
      assert.equal(results.bareSize.width, 420);
      assert.equal(results.bareSize.height, 320);
      assert.equal(results.bareGone, false);
    });

    it("moves the traffic lights only where there are any", () => {
      assert.equal(
        results.bareTrafficLights,
        process.platform === "darwin" ? "moved" : "UNSUPPORTED",
      );
    });

    it("stores a ledger in a real SQLite file", () => {
      assert.equal(results.dbFatal, undefined, results.dbFatal);
      assert.equal(results.dbPath, true);
      assert.equal(results.dbChanges, 1);
      assert.equal(results.dbRowId, 1);
    });

    it("refuses to round an integer rather than quietly changing it", () => {
      // The bug this capability exists to not have: a balance in minor units
      // past 2^53 coming back with its low bits gone.
      assert.equal(results.dbBigExact, true);
      assert.equal(results.dbBigType, "bigint");
      // Reading the same column without asking for bigint is an error, not a
      // rounded answer.
      assert.equal(results.dbTruncationCode, "INVALID_PARAMS");
    });

    it("commits a transaction that returns and rolls back one that throws", () => {
      assert.equal(results.dbRollbackThrew, true);
      assert.equal(results.dbAfterRollback, 0);
      assert.equal(results.dbAfterCommit, 1);
    });

    it("enforces a foreign key, which SQLite does not do by default", () => {
      assert.equal(results.dbForeignKeyCode, "IO_ERROR");
    });

    it("takes a snapshot that is a database on its own", () => {
      assert.equal(results.dbSnapshot, true);
      // Both entries plus the committed one.
      assert.equal(results.dbSnapshotRows, 3);
    });

    it("answers rather than hangs once it is closed", () => {
      assert.equal(results.dbClosedCode, "NOT_FOUND");
    });

    it("opens a WebSocket with headers the webview could not send", () => {
      assert.equal(results.socketFatal, undefined, results.socketFatal);
      // The server picked the second subprotocol offered, and the client
      // reports what was chosen rather than what was asked for.
      assert.equal(results.socketProtocol, "other");
      // The whole reason this exists rather than the page's own WebSocket.
      assert.equal(results.socketMessages[0], "auth:Bearer integration");
    });

    it("carries text and binary messages both ways", () => {
      assert.equal(results.socketMessages[1], "echo:hello");
      // Sent [1,2,3], echoed back reversed, and still bytes at this end.
      assert.deepEqual(results.socketMessages[2], [3, 2, 1]);
    });

    it("closes a socket with the code it was given", () => {
      assert.equal(results.socketClosed.code, 1000);
      assert.equal(results.socketClosed.reason, "done");
      assert.equal(results.socketClosed.error, undefined);
    });

    it("can be told to hide rather than close", () => {
      assert.equal(results.closeBehaviorDefault, "close");
      assert.equal(results.closeBehaviorAfter, "hide");
    });

    it("survives whatever a page posts at the bridge", () => {
      // Eleven malformed messages - not JSON, wrong shapes, 5000-deep
      // nesting, a 200 kB method name - and the runtime is still answering.
      // A page is untrusted content; crashing on its input would be a way to
      // take the application down from inside it.
      assert.equal(results.aliveAfterGarbage, results.platform);
      assert.equal(results.stillWorksAfterGarbage, true);
      assert.equal(
        results.postThrew,
        undefined,
        "posting itself should not throw",
      );
    });

    it("says whether it can report sleep and wake", () => {
      // macOS is wired up; the others say so rather than staying silent and
      // letting an application assume it will be told.
      assert.equal(results.powerSupported, process.platform === "darwin");
      assert.equal(results.powerListenersOk, true);
    });

    it("reports no drops when the config has not asked for them", () => {
      // dragDrop is absent from this fixture's permissions, so the runtime
      // leaves drops to WebKit and reports nothing.
      assert.equal(results.dropsWithoutPermission, 0);
    });

    it("maximises to the screen even with a maximum set", () => {
      // Not an oversight. A maximised surface that commits a smaller geometry
      // than the compositor configured is an xdg-shell protocol error, and
      // Wayland kills the process for it - so the limits come off while
      // maximised and go back on when it is restored.
      const display = results.currentScreen;
      assert.ok(
        results.maximizedWithMax.width > 520,
        `a 520-wide maximum should not survive maximising, got ${JSON.stringify(results.maximizedWithMax)}`,
      );
      assert.ok(results.maximizedWithMax.width <= display.size.width);

      // And the limit is still accepted, and does not disturb a later resize.
      assert.equal(results.minSizeCode, null);
      assert.deepEqual(results.sizeAfterLimits, { width: 640, height: 480 });
    });

    it("sets a badge and a progress bar, and rejects nonsense", () => {
      // null means no error was thrown.
      assert.equal(results.progressCode, null);
      assert.equal(results.progressDoneCode, null);
      assert.equal(results.progressBadValue, "INVALID_PARAMS");
      assert.equal(results.progressBadState, "INVALID_PARAMS");

      // The badge is macOS and Linux; Windows says so rather than pretending.
      const expected = process.platform === "win32" ? "UNSUPPORTED" : null;
      assert.equal(results.badgeCode, expected);
      assert.equal(results.badgeClearCode, expected);
    });

    it("says macOS has no taskbar to skip", () => {
      const expected = process.platform === "darwin" ? "UNSUPPORTED" : null;
      assert.equal(results.skipTaskbarCode, expected);
    });

    it("reports a file appearing under a watched directory", () => {
      console.log(
        "DEBUG watch:",
        JSON.stringify({ saw: results.watchSaw, watched: results.watchedPath }),
      );
      assert.ok(results.watchId);
      assert.deepEqual(results.watchList, [results.watchId]);
      assert.ok(
        results.watchSaw.length > 0,
        "the watch reported nothing when a file was created under it",
      );
      // Which change kinds arrive is platform-dependent; that the right file
      // was reported, by the right watch, is not.
      assert.ok(
        results.watchSaw.every((change) => change.id === results.watchId),
      );
      assert.ok(
        results.watchSaw.some((change) => change.path.endsWith("note.txt")),
        `nothing named the written file: ${JSON.stringify(results.watchSaw)}`,
      );
    });

    it("stops a watch, and scopes one like a read", () => {
      assert.deepEqual(results.watchListAfter, []);
      assert.equal(results.unwatchUnknownCode, "NOT_FOUND");
      assert.equal(results.watchDeniedCode, "PERMISSION_DENIED");
    });

    it("reports the displays a window can be placed on", () => {
      assert.ok(Array.isArray(results.screens));
      assert.ok(
        results.screens.length >= 1,
        "a machine running this has a screen",
      );

      for (const display of results.screens) {
        assert.equal(typeof display.size.width, "number");
        assert.ok(display.size.width > 0 && display.size.height > 0);
        assert.equal(typeof display.position.x, "number");
        assert.ok(display.scaleFactor >= 1);
      }

      assert.equal(results.screens.filter((s) => s.primary).length, 1);
      assert.equal(results.primaryScreen.primary, true);
      // The fixture's window is somewhere, and that somewhere is a screen.
      assert.ok(results.currentScreen);
    });

    it("reports screens in the same units window methods take", () => {
      // The real check. Physical pixels would put a window at half the
      // intended coordinates on a Retina display, and comparing a window's
      // own position against its screen is what catches that: on this
      // machine the two differ by a factor of two if the units disagree.
      const display = results.currentScreen;
      const { x, y } = results.windowPosition;

      assert.ok(
        x >= display.position.x && x < display.position.x + display.size.width,
        `window x=${x} is not inside its own screen`,
      );
      assert.ok(
        y >= display.position.y && y < display.position.y + display.size.height,
        `window y=${y} is not inside its own screen`,
      );

      // The one that actually distinguishes the two. A window position always
      // fits inside a screen reported too large, so bounds alone prove
      // nothing; a maximised window is a length in logical pixels that has to
      // match the screen's own.
      const ratio = results.maximizedSize.width / display.size.width;
      assert.ok(
        ratio > 0.7,
        `a maximised window is ${results.maximizedSize.width} but its screen claims ` +
          `${display.size.width} (ratio ${ratio.toFixed(2)}) - the screen looks like physical pixels`,
      );
    });

    it("answers about a point, without inventing a screen for it", () => {
      assert.ok(
        results.screenAtOrigin,
        "a point inside a screen is on that screen",
      );
      assert.equal(results.screenAtOrigin.name, results.primaryScreen.name);
      assert.equal(results.screenFarAway, null);
    });

    it("claims a key combination system-wide, and gives it back", () => {
      assert.equal(results.shortcutBefore, false);
      assert.equal(results.shortcutAfter, true);
      assert.equal(results.shortcutRegistered.id, "probe");
      assert.deepEqual(results.shortcutList, [
        { id: "probe", accelerator: "CmdOrCtrl+Alt+Shift+F9" },
      ]);
      assert.equal(results.shortcutGone, false);
    });

    it("refuses a combination it already holds, and one that is not a key", () => {
      assert.equal(results.shortcutTwiceCode, "ALREADY_EXISTS");
      assert.equal(results.shortcutBadCode, "INVALID_PARAMS");
      assert.equal(results.shortcutUnknownCode, "NOT_FOUND");
    });

    it("will not register an unpackaged build to start at login", () => {
      // It would name a path in a temporary directory, which is worse than
      // not working: it would half-work until the directory went away.
      assert.equal(results.autostartCode, "UNSUPPORTED");
    });

    it("leaves nothing behind in the user's login items", () => {
      // Not paranoia. An earlier version of that check let this through, and
      // the suite quietly registered the test runtime to start at login on
      // the machine it ran on. Asserting the refusal is not the same as
      // asserting nothing was written.
      assert.equal(
        existsSync(autostartEntry),
        false,
        `${autostartEntry} exists - the suite registered itself to start at login`,
      );
    });

    it("keeps a secret in the OS credential store", (t) => {
      if (results.secretsUnsupported) {
        // A machine with no credential store cannot be made to have one, and
        // saying so beats a red failure that means "not installed here".
        t.skip("this machine has no credential store");
        return;
      }
      // Not a file the application wrote: this is the Keychain, the Windows
      // Credential Manager or the Secret Service, depending on where it ran.
      assert.equal(results.secretBefore, null, "the store should start empty");
      assert.equal(results.secretRead, "value-with-unicode-\u00e9");
      assert.equal(results.secretHas, true);
      assert.equal(results.secretDeleted, true);
      assert.equal(results.secretAfter, null);
      // Deleting what is not there is an answer, not a failure.
      assert.equal(results.secretDeleteAgain, false);
      assert.equal(results.secretEmptyKeyCode, "INVALID_PARAMS");
    });

    it("shows only the HID devices the config allows", () => {
      assert.equal(results.hidIsList, true);
      // The permission names one vendor that nothing has, so a list with
      // anything in it means the filter is not being applied.
      assert.deepEqual(results.hidVendors, []);
      assert.equal(results.hidMissingCode, "NOT_FOUND");
    });

    it("scopes service discovery by type", () => {
      assert.equal(results.mdnsDeniedCode, "PERMISSION_DENIED");
      // Passing a hostname instead of a service type is the mistake worth
      // catching, so it is an error rather than an empty result.
      assert.equal(results.mdnsNotAServiceCode, "INVALID_PARAMS");
    });

    it("starts and stops a browse", () => {
      assert.deepEqual(results.mdnsBrowsingBefore, []);
      assert.equal(results.mdnsStarted.started, true);
      assert.deepEqual(results.mdnsBrowsingAfter, ["_vantailtest._tcp.local."]);
      assert.equal(results.mdnsStopped, true);
    });

    it("carries a clipboard round trip", () => {
      // A non-ASCII character on purpose: the clipboard has to carry it back
      // unchanged. Written as an escape so the source stays ASCII.
      assert.equal(results.clipboard, "vantail clipboard \u2713");
    });

    it("carries an image through the clipboard, pixels intact", () => {
      assert.equal(results.hasImageAfter, true, "nothing was on the clipboard");
      assert.deepEqual(results.imageSize, { width: 7, height: 4 });
      assert.equal(results.imageIsPng, true, "what came back was not a PNG");
      // x=3, y=2 in the pattern the fixture drew.
      assert.deepEqual(results.imagePixel, [90, 120, 0x40, 255]);
    });

    it("clears an image as well as text", () => {
      assert.equal(results.hasImageAfterClear, false);
    });

    it("removes what it created", () => {
      assert.equal(results.existsAfterRemove, false);
    });
  },
);

/** The page under test: real SDK, real protocol, results written to disk. */
function fixture(scratch, resultsPath, devicePort) {
  return `<!doctype html>
<meta charset="utf-8">
<title>integration</title>
<body>
<script>
  // A module that fails to parse never runs its own error handling, and a
  // hung call would otherwise show up as nothing but a test timeout. This
  // classic script guarantees the page always reports something.
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
  setTimeout(function () { window.__finish("watchdog"); }, 10000);
</script>
<script type="module">
import {
  app, appWindow, clipboard, createWindow, currentWindow, database, filesystem, invoke,
  isVantail, listWindows, menu, notification, onWindowClosed, os,
  autostart, fileDrop, hid, mdns, network, power, process as childProcess, runtimeVersion,
  screen, secrets, shell, titleBarMetrics,
  shortcut,
  tray, VantailError,
} from "./api/index.js";

const results = window.__results;
const scratch = ${JSON.stringify(scratch)};
const device = ${JSON.stringify(`http://127.0.0.1:${devicePort}`)};

/** Run a call that is expected to fail and hand back the error. */
const failure = async (promise) => {
  try {
    await promise;
    return { code: "UNEXPECTEDLY_SUCCEEDED" };
  } catch (error) {
    return VantailError.is(error) ? error : { code: "NOT_A_VANTAIL_ERROR", message: String(error) };
  }
};

try {
  results.isVantail = isVantail();
  results.runtimeVersion = runtimeVersion();
  results.infoSync = app.infoSync();
  results.appInfo = await app.info();
  results.platform = await os.platform();

  const resized = new Promise((resolve) => {
    const stop = appWindow.onResized((size) => {
      stop();
      resolve(size);
    });
  });

  results.size = await appWindow.size();
  await appWindow.setTitle("Renamed");
  results.titleAfterSet = await appWindow.title();
  await appWindow.setSize(700, 500);
  results.sizeAfterSet = await appWindow.size();
  results.resizeEvent = await resized;

  await filesystem.mkdir(scratch + "/nested", { recursive: true });
  const file = scratch + "/note.txt";
  results.written = await filesystem.writeText(file, "hello \u00fcnicode \u2028 line");
  results.read = await filesystem.readText(file);
  results.exists = await filesystem.exists(file);
  results.statIsFile = (await filesystem.stat(file)).isFile;
  results.readDir = await filesystem.readDir(scratch);

  const denied = await failure(filesystem.readText("/etc/passwd"));
  results.deniedCode = denied.code;
  results.deniedMessage = denied.message;
  results.traversalCode = (await failure(filesystem.readText(scratch + "/../../etc/hosts"))).code;
  results.unknownCode = (await failure(invoke("nope.doThing"))).code;
  results.badParamsCode = (await failure(appWindow.setSize("wide", 1))).code;
  results.notificationCode = (await failure(notification.show("hi"))).code;

  // --- a second window, and a message to it ---
  results.currentLabel = currentWindow();
  results.windowsBefore = await listWindows();

  const pong = new Promise((resolve) => {
    const stop = app.listen("pong", (payload) => {
      stop();
      resolve(payload);
    });
  });

  const second = await createWindow("second", { url: "second.html", width: 320, height: 240, title: "Second" });
  results.windowsAfter = await listWindows();
  results.secondTitle = await second.title();

  await app.emit("ping", { note: "hello" }, { to: "second" });
  results.pong = await pong;

  results.duplicateLabelCode = (await failure(createWindow("second"))).code;
  results.badLabelCode = (await failure(createWindow("not a label"))).code;

  const closed = new Promise((resolve) => {
    const stop = onWindowClosed((event) => {
      stop();
      resolve(event);
    });
  });
  results.closed = await second.close();
  results.closeEvent = await closed;
  results.windowsAfterClose = await listWindows();

  // --- menu ---
  await menu.set([
    {
      type: "submenu",
      label: "File",
      items: [
        { id: "new", label: "New", accelerator: "CmdOrCtrl+N" },
        { type: "separator" },
        { type: "checkbox", id: "wrap", label: "Wrap", checked: true },
        { type: "predefined", item: "quit" },
      ],
    },
  ]);
  results.checkedBefore = await menu.isChecked("wrap");
  await menu.setChecked("wrap", false);
  results.checkedAfter = await menu.isChecked("wrap");
  results.notACheckboxCode = (await failure(menu.setChecked("new", true))).code;

  // An accelerator the platform cannot parse costs that one item, not the
  // whole menu - which on macOS would take Cmd-Q and Cmd-C with it.
  const partial = await menu.set([
    {
      type: "submenu",
      label: "Edit",
      items: [
        { id: "good", label: "Good", accelerator: "CmdOrCtrl+G" },
        { id: "bad", label: "Bad", accelerator: "Nonsense+Q" },
        { type: "checkbox", id: "flag", label: "Flag", checked: true },
      ],
    },
  ]);
  results.skipped = partial.skipped;
  results.goodItemSurvived = await menu
    .setEnabled("good", false)
    .then(() => true)
    .catch(() => false);
  results.skippedItemIsGone = (await failure(menu.setEnabled("bad", false))).code;
  results.checkboxSurvivedSkip = await menu.isChecked("flag");

  // Return is what the key is called on an Apple keyboard.
  results.returnSkipped = (
    await menu.set([{ id: "run", label: "Run", accelerator: "CmdOrCtrl+Return" }])
  ).skipped;

  // --- tray ---
  await tray.set({ icon: "icon.png", tooltip: "Integration", iconAsTemplate: true,
    menu: [{ id: "open", label: "Open" }] });
  results.trayExists = await tray.exists();
  results.missingIconCode = (await failure(tray.setIcon("nope.png"))).code;

  // --- processes ---
  const runner = ${JSON.stringify(process.execPath)};
  results.echo = await childProcess.execute(runner, ["-e", "process.stdout.write('hello')"]);
  results.deniedProgramCode = (await failure(childProcess.execute("definitely-not-allowed", []))).code;
  results.deniedArgsCode = (
    await failure(childProcess.execute(runner, ["-e", "process.exit(1)"]))
  ).code;
  results.shellOpenCode = (await failure(shell.open("https://example.com"))).code;

  // --- binary files ---
  const iconBytes = await filesystem.readBinary((await os.resourceDir()) + "/icon.png");
  results.pngHead = [...iconBytes.slice(0, 4)];
  const copy = scratch + "/icon-copy.png";
  await filesystem.writeBinary(copy, iconBytes);
  const back = await filesystem.readBinary(copy);
  results.pngCopyMatches =
    back.length === iconBytes.length && back.every((byte, index) => byte === iconBytes[index]);

  // --- a device the webview cannot reach on its own ---
  results.fetchFailed = await fetch(device + "/status").then(
    () => false,
    () => true,
  );
  const viaRuntime = await network.request({ url: device + "/status" });
  results.networkStatus = viaRuntime.status;
  results.networkBody = viaRuntime.body;
  results.networkDeniedCode = (
    await failure(network.request({ url: "http://192.168.99.99/x" }))
  ).code;
  results.networkRedirectCode = (
    await failure(network.request({ url: device + "/redirect-away" }))
  ).code;

  const cookies = await network.request({ url: device + "/cookies" });
  results.cookiePairs = cookies.headerPairs
    .filter(([name]) => name === "set-cookie")
    .map(([, value]) => value);
  results.cookieJoined = cookies.headers["set-cookie"];
  results.cookieBytes = cookies.bodyBytes;
  results.cookieTiming = cookies.timing;

  const hopped = await network.request({ url: device + "/hop" });
  results.hopStatus = hopped.status;
  results.hopRedirects = hopped.redirects;

  const stream = await network.stream({ url: device + "/stream" });
  results.streamStatus = stream.status;
  results.streamContentType = stream.headers["content-type"];
  const streamChunks = [];
  const streamDone = new Promise((resolve) => stream.onEnd(resolve));
  stream.onChunk((chunk) => streamChunks.push(chunk));
  results.streamEnd = await streamDone;
  results.streamText = streamChunks.join("");
  results.streamChunkCount = streamChunks.length;

  // Switching this window's title bar, and the page seeing it change.
  const readCss = () =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--vantail-titlebar-height")
      .trim();

  results.toggleBefore = { style: await appWindow.titleBarStyle(), css: readCss() };
  results.toggleHiddenMetrics = await appWindow.setTitleBarStyle("hidden");
  results.toggleHidden = {
    style: await appWindow.titleBarStyle(),
    css: readCss(),
    sync: titleBarMetrics(),
  };
  results.toggleBackMetrics = await appWindow.setTitleBarStyle("default");
  results.toggleBack = {
    style: await appWindow.titleBarStyle(),
    css: readCss(),
    sync: titleBarMetrics(),
  };

  // A taller bar than the platform's, and back.
  await appWindow.setTitleBarStyle("hidden");
  const nativeHeight = titleBarMetrics().height;
  const nativeInsetLeft = titleBarMetrics().insetLeft;
  results.tallMetrics = await appWindow.setTitleBarHeight(48);
  // Asking for something no platform can provide: whatever comes back is the
  // tallest bar there is, which is what tells a request that was met from one
  // that ran out of room.
  results.ceilingMetrics = await appWindow.setTitleBarHeight(4000);
  await appWindow.setTitleBarHeight(48);
  results.tallCss = readCss();
  results.tallSync = titleBarMetrics();
  // Moving them by hand, and putting them back.
  // macOS is the only platform with traffic lights to move - everywhere else
  // the title bar takes its buttons with it - so this is UNSUPPORTED there,
  // which is the answer rather than a silent no-op. Asked for either way, so
  // the test can check the right one happened.
  results.movedLights = await appWindow
    .setTrafficLightPosition(12, 14)
    .then((metrics) => ({ moved: true, height: metrics.height }))
    .catch((error) => ({ moved: false, code: error.code }));
  // Re-centring is not platform-specific: with nothing to move it is simply a
  // re-measure, so it answers with the metrics everywhere.
  results.centredLights = await appWindow.centerTrafficLights();
  results.backToNative = await appWindow.setTitleBarHeight(null);
  results.nativeHeight = nativeHeight;
  results.nativeInsetLeft = nativeInsetLeft;
  await appWindow.setTitleBarStyle("default");

  results.mainTitleBar = titleBarMetrics();
  results.mainTitleBarCss = getComputedStyle(document.documentElement)
    .getPropertyValue("--vantail-titlebar-height")
    .trim();

  // --- a window with no title bar ---
  try {
    const bare = await createWindow("bare", {
      url: "second.html",
      width: 420,
      height: 320,
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 16, y: 18 },
      visible: false,
    });
    results.bareExists = await bare.exists();
    results.bareSize = await bare.size();
    // macOS keeps the traffic lights, so it can move them; nowhere else has
    // any, and says so rather than pretending.
    results.bareTrafficLights = await bare
      .setTrafficLightPosition(12, 14)
      .then(() => "moved")
      .catch((error) => error.code);
    await bare.close();
    results.bareGone = await bare.exists();
  } catch (error) {
    results.bareFatal = String(error);
  }

  // --- database ---
  try {
    const dbPath = ${JSON.stringify(scratch)} + "/ledger.sqlite";
    const db = await database.open({ path: dbPath });
    results.dbPath = db.path.endsWith("ledger.sqlite");

    await db.execute(
      "create table entry(id integer primary key, minor integer not null, note text)",
    );
    const inserted = await db.execute(
      "insert into entry(minor, note) values (?, ?)",
      [1250, "coffee"],
    );
    results.dbChanges = inserted.changes;
    results.dbRowId = inserted.lastInsertRowId;

    // An amount past 2^53 must come back exactly, not rounded.
    const huge = 9007199254740993n;
    await db.execute("insert into entry(minor, note) values (?, ?)", [huge, "big"]);
    const big = await db.query("select minor from entry where note = ?", ["big"], {
      bigint: true,
    });
    results.dbBigExact = big[0].minor === huge;
    results.dbBigType = typeof big[0].minor;

    // And reading it without asking is an error rather than a wrong number.
    results.dbTruncationCode = (
      await failure(db.query("select minor from entry where note = ?", ["big"]))
    ).code;

    // A transaction that throws leaves nothing behind.
    results.dbRollbackThrew = await db
      .transaction(async (tx) => {
        await tx.execute("insert into entry(minor, note) values (?, ?)", [1, "doomed"]);
        throw new Error("no");
      })
      .then(() => false)
      .catch(() => true);
    results.dbAfterRollback = (
      await db.query("select count(*) as n from entry where note = ?", ["doomed"])
    )[0].n;

    // And one that returns commits.
    await db.transaction(async (tx) => {
      await tx.execute("insert into entry(minor, note) values (?, ?)", [2, "kept"]);
    });
    results.dbAfterCommit = (
      await db.query("select count(*) as n from entry where note = ?", ["kept"])
    )[0].n;

    // A declared foreign key is actually enforced.
    await db.execute("create table child(parent integer references entry(id))");
    results.dbForeignKeyCode = (
      await failure(db.execute("insert into child values (99999)"))
    ).code;

    await db.checkpoint();
    const copy = await db.snapshot(${JSON.stringify(scratch)} + "/backup.sqlite");
    results.dbSnapshot = copy.path.endsWith("backup.sqlite");

    // The copy is a database in its own right, which is what makes "back up
    // your ledger" a real feature.
    const restored = await database.open({ path: copy.path, readOnly: true });
    results.dbSnapshotRows = (
      await restored.query("select count(*) as n from entry")
    )[0].n;
    await restored.close();

    await db.close();
    results.dbClosedCode = (await failure(db.query("select 1"))).code;
  } catch (error) {
    results.dbFatal = String(error);
  }

  // --- websocket ---
  try {
    const deadline = (promise, what) =>
      Promise.race([
        promise,
        new Promise((_, no) =>
          setTimeout(() => no(new Error("timed out waiting for " + what)), 5000),
        ),
      ]);

    const socket = await deadline(
      network.socket({
        url: device.replace("http://", "ws://") + "/socket",
        headers: { authorization: "Bearer integration" },
        protocols: ["chat", "other"],
      }),
      "the handshake",
    );
    results.socketProtocol = socket.protocol ?? null;

    const messages = [];
    const three = new Promise((resolve) => {
      socket.onMessage((data) => {
        messages.push(typeof data === "string" ? data : Array.from(data));
        if (messages.length === 3) resolve();
      });
    });

    await socket.send("hello");
    await socket.sendBytes(new Uint8Array([1, 2, 3]));
    await deadline(three, "three messages");
    results.socketMessages = messages;

    const closed = new Promise((resolve) => socket.onClose(resolve));
    await socket.close(1000, "done");
    results.socketClosed = await deadline(closed, "the close");
  } catch (error) {
    results.socketFatal = String(error);
  }

  const forever = await network.stream({ url: device + "/forever" });
  const foreverDone = new Promise((resolve) => forever.onEnd(resolve));
  results.foreverCancelled = await forever.cancel();
  results.foreverEnd = await foreverDone;
  results.foreverCancelAgain = await forever.cancel();

  // --- surviving a close ---
  results.closeBehaviorDefault = await appWindow.closeBehavior();
  await appWindow.setCloseBehavior("hide");
  results.closeBehaviorAfter = await appWindow.closeBehavior();
  await appWindow.setCloseBehavior("close");

  // --- the OS credential store ---
  const secretKey = "integration.token";
  // --- hostile input ----------------------------------------------------------
  // The bridge is the boundary between page content and native capability, so
  // whatever a page posts, the runtime has to stay up and keep answering.
  // These go through window.ipc directly: the SDK would never build them.
  {
    const nasty = [
      "not json at all",
      "",
      "null",
      "[]",
      "12345",
      JSON.stringify({ id: "no-method" }),
      JSON.stringify({ method: "os.platform" }),
      JSON.stringify({ id: 1, method: 2, params: 3 }),
      JSON.stringify({ id: "x", method: "os.platform", params: "not an object" }),
      // Deeper than any parser should follow.
      '{"id":"deep","method":"os.platform","params":' +
        "[".repeat(5000) +
        "]".repeat(5000) +
        "}",
      // A method name nobody has room for.
      JSON.stringify({ id: "long", method: "a".repeat(200000) }),
    ];

    for (const message of nasty) {
      try {
        window.ipc.postMessage(message);
      } catch (error) {
        results.postThrew = String(error);
      }
    }

    // The only assertion that matters: it is still there, and still answers.
    await new Promise((done) => setTimeout(done, 500));
    results.aliveAfterGarbage = await os.platform();
    results.stillWorksAfterGarbage = (await appWindow.size()).width > 0;
  }

  // --- sleep and wake --------------------------------------------------------
  // Whether the events fire cannot be tested without sleeping the machine.
  // What can be tested is that an application is told the truth about whether
  // to expect them.
  results.powerSupported = await power.supported();
  {
    const stops = [power.onSuspend(() => {}), power.onResume(() => {})];
    for (const stop of stops) stop();
    results.powerListenersOk = true;
  }

  // --- file drops -----------------------------------------------------------
  // A drag cannot be automated, so what is checked here is that the API is
  // present and that nothing fires when the config has not asked for it.
  // Whether a real drop is reported is verified by hand.
  {
    const seen = [];
    const stops = [
      fileDrop.onEnter((e) => seen.push(["enter", e])),
      fileDrop.onDrop((e) => seen.push(["drop", e])),
      fileDrop.onLeave(() => seen.push(["leave"])),
    ];
    await new Promise((done) => setTimeout(done, 300));
    results.dropsWithoutPermission = seen.length;
    for (const stop of stops) stop();
  }

  // --- window limits and the dock ---
  const attemptLater = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return VantailError.is(error) ? error.code : String(error);
    }
  };
  // A limit constrains resizes that go through the window system - a user
  // dragging an edge, or maximising. It does not clamp setSize, which asks the
  // platform directly; that is a real difference and worth pinning down.
  // A maximised window must be exactly the size the window system chose, so
  // the limits come off while it is maximised - on Wayland a mismatch is a
  // protocol error that kills the process. Setting one and maximising is
  // therefore expected to fill the screen, not to obey the limit.
  await appWindow.setMaxSize(520, 380);
  await appWindow.maximize();
  await new Promise((done) => setTimeout(done, 800));
  results.maximizedWithMax = await appWindow.size();
  await appWindow.unmaximize();
  await appWindow.setMaxSize(null, null);
  await new Promise((done) => setTimeout(done, 400));

  // Accepted, and does not disturb a later setSize.
  results.minSizeCode = await attemptLater(appWindow.setMinSize(300, 200));
  await appWindow.setSize(640, 480);
  await new Promise((done) => setTimeout(done, 400));
  results.sizeAfterLimits = await appWindow.size();
  await appWindow.setMinSize(null, null);

  const attempt = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return VantailError.is(error) ? error.code : String(error);
    }
  };

  results.badgeCode = await attempt(app.setBadge("7"));
  results.badgeClearCode = await attempt(app.setBadge(null));
  results.progressCode = await attempt(app.setProgress({ value: 40, state: "normal" }));
  results.progressDoneCode = await attempt(app.setProgress({ state: "none" }));
  results.progressBadValue = (await failure(app.setProgress({ value: 900 }))).code;
  results.progressBadState = (await failure(app.setProgress({ state: "sideways" }))).code;
  results.skipTaskbarCode = await attempt(appWindow.setSkipTaskbar(true));

  // --- watching the filesystem ---------------------------------------------
  {
    const watched = scratch + "/watched";
    await filesystem.mkdir(watched);

    const seen = [];
    const stop = filesystem.onChange((change) => seen.push(change));
    const watch = await filesystem.watch(watched, { recursive: true });
    results.watchId = watch.id;
    results.watchList = await filesystem.watches();

    // Give the watcher a moment to be listening before making a change, then
    // a moment to report it. This is the one place polling is unavoidable.
    await new Promise((done) => setTimeout(done, 500));
    await filesystem.writeText(watched + "/note.txt", "hello");
    // Wait for the event about the file, not merely for the first event.
    // Watching a directory that was just created replays its own creation
    // first, so stopping at the first arrival catches the mkdir and misses
    // the write.
    const sawFile = () => seen.some((change) => change.path.endsWith("note.txt"));
    for (let i = 0; i < 60 && !sawFile(); i += 1) {
      await new Promise((done) => setTimeout(done, 100));
    }

    // The paths themselves, not a boolean about them: a reduced assertion
    // cannot tell you what actually arrived.
    results.watchSaw = seen.map((change) => ({
      kind: change.kind,
      id: change.id,
      path: change.path,
    }));
    results.watchedPath = watched;

    stop();
    await filesystem.unwatch(watch.id);
    results.watchListAfter = await filesystem.watches();
    results.unwatchUnknownCode = (await failure(filesystem.unwatch(watch.id))).code;
    // Watching is a read, so it is refused exactly where a read is.
    results.watchDeniedCode = (await failure(filesystem.watch("/etc"))).code;
  }

  // --- screens ---------------------------------------------------------------
  results.screens = await screen.list();
  results.primaryScreen = await screen.primary();
  results.currentScreen = await screen.current();
  // A point inside the primary screen has to land on a screen; one far
  // outside every screen must not invent one.
  results.screenAtOrigin = await screen.fromPoint(
    results.primaryScreen.position.x + 10,
    results.primaryScreen.position.y + 10,
  );
  results.screenFarAway = await screen.fromPoint(-999999, -999999);
  // Window coordinates and screen coordinates have to be the same units, or
  // placing a window using a screen's bounds lands somewhere else.
  results.windowPosition = await appWindow.position();
  // A maximised window fills its screen. Comparing the two is what tells
  // logical pixels from physical ones: if the screen were reported in
  // physical pixels the ratio would be about 1/scaleFactor, not about 1.
  await appWindow.maximize();
  await new Promise((done) => setTimeout(done, 400));
  results.maximizedSize = await appWindow.size();
  await appWindow.unmaximize();

  // --- global shortcuts ---------------------------------------------------
  // Rare enough not to fight whatever else is on the machine, but a key every
  // keyboard layout actually has. F19 seemed safer until a Linux keymap that
  // stops at F12 refused it.
  const combo = "CmdOrCtrl+Alt+Shift+F9";
  results.shortcutBefore = await shortcut.isRegistered(combo);
  results.shortcutRegistered = await shortcut.register(combo, { id: "probe" });
  results.shortcutAfter = await shortcut.isRegistered(combo);
  results.shortcutList = await shortcut.list();
  // Twice is a conflict with itself, and should say so rather than silently
  // replacing the first one.
  results.shortcutTwiceCode = (
    await failure(shortcut.register(combo, { id: "again" }))
  ).code;
  results.shortcutBadCode = (await failure(shortcut.register("NotAKey+++"))).code;
  await shortcut.unregister(combo);
  results.shortcutGone = await shortcut.isRegistered(combo);
  results.shortcutUnknownCode = (await failure(shortcut.unregister(combo))).code;
  await shortcut.unregisterAll();

  // --- autostart ------------------------------------------------------------
  // This runtime is unpackaged, so the honest answer is that it cannot.
  results.autostartCode = (await failure(autostart.enable())).code;

  // Not every machine has one. A container, and a Linux CI runner, have no
  // Secret Service running - the runtime says UNSUPPORTED, which is the right
  // answer and not something to fail over.
  const storeProbe = await failure(secrets.get(secretKey));
  results.secretsUnsupported = storeProbe.code === "UNSUPPORTED";

  if (!results.secretsUnsupported) {
    results.secretBefore = await secrets.get(secretKey);
    await secrets.set(secretKey, "value-with-unicode-\u00e9");
    results.secretRead = await secrets.get(secretKey);
    results.secretHas = await secrets.has(secretKey);
    results.secretDeleted = await secrets.delete(secretKey);
    results.secretAfter = await secrets.get(secretKey);
    results.secretDeleteAgain = await secrets.delete(secretKey);
    results.secretEmptyKeyCode = (await failure(secrets.get(""))).code;
  }

  // --- raw devices ---
  const devices = await hid.list();
  results.hidIsList = Array.isArray(devices);
  // Only the permitted vendor may appear, and nothing has that one.
  results.hidVendors = [...new Set(devices.map((device) => device.vendorId))];
  results.hidMissingCode = (await failure(hid.open("no-such-device"))).code;

  // --- service discovery ---
  results.mdnsDeniedCode = (
    await failure(mdns.discover({ service: "_hub._tcp.local" }))
  ).code;
  results.mdnsNotAServiceCode = (
    await failure(mdns.discover({ service: "hub.local" }))
  ).code;
  results.mdnsBrowsingBefore = await mdns.browsing();
  results.mdnsStarted = await mdns.browse("_vantailtest._tcp.local");
  results.mdnsBrowsingAfter = await mdns.browsing();
  results.mdnsStopped = await mdns.stop("_vantailtest._tcp.local");

  // Whatever the person running this had copied. Put back at the end: a test
  // suite that empties your clipboard is a rude thing to run.
  const clipboardBefore = await clipboard.readText();

  await clipboard.writeText("vantail clipboard \u2713");
  results.clipboard = await clipboard.readText();

  // An image, through the same clipboard the user pastes from. The pixels are
  // deliberately not uniform, so a transposed or shifted image would not
  // still compare equal.
  {
    const width = 7;
    const height = 4;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    const pixels = context.createImageData(width, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        pixels.data[at] = x * 30;
        pixels.data[at + 1] = y * 60;
        pixels.data[at + 2] = 0x40;
        pixels.data[at + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
    const png = new Uint8Array(
      await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
    );

    results.hadImageBefore = await clipboard.hasImage();
    await clipboard.writeImage(png);
    results.hasImageAfter = await clipboard.hasImage();

    const read = await clipboard.readImage();
    results.imageSize = read && { width: read.width, height: read.height };
    results.imageIsPng =
      read !== null &&
      read.data[0] === 0x89 &&
      String.fromCharCode(read.data[1], read.data[2], read.data[3]) === "PNG";

    // Decode what came back and compare a pixel, so this is about the image
    // and not merely about some bytes arriving.
    if (read) {
      const bitmap = await createImageBitmap(
        new Blob([read.data], { type: "image/png" }),
      );
      const check = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = check.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const back = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const at = (2 * width + 3) * 4;
      results.imagePixel = [back[at], back[at + 1], back[at + 2], back[at + 3]];
    }

    // Text and images are separate: clearing removes both.
    await clipboard.clear();
    results.hasImageAfterClear = await clipboard.hasImage();
  }

  if (clipboardBefore) await clipboard.writeText(clipboardBefore);

  await filesystem.remove(file);
  await filesystem.remove(scratch + "/nested", { recursive: true });
  results.existsAfterRemove = await filesystem.exists(file);
} catch (error) {
  results.fatal = String((error && error.stack) || error);
}

window.__finish("script complete");
</script>
</body>`;
}

/** The smallest valid RGBA PNG, built rather than checked in. */
function tinyPng() {
  const width = 8;
  const height = 8;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]));
    for (let x = 0; x < width; x += 1) {
      rows.push(Buffer.from([255, 255, 255, (x + y) % 2 === 0 ? 255 : 0]));
    }
  }

  const chunk = (tag, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(tag, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return crc ^ 0xffffffff;
}

/** The page the second window loads: it answers a ping and nothing else. */
function secondWindow() {
  return `<!doctype html>
<meta charset="utf-8">
<title>second</title>
<body>
<script type="module">
import { app, currentWindow } from "./api/index.js";
app.listen("ping", (payload) => {
  void app.emit("pong", { seenBy: currentWindow(), note: payload.note }, { to: "main" });
});
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
    }, 30_000);

    child.once("error", reject);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0) return resolvePromise({ stderr });
      reject(new Error(`runtime exited with ${exitCode}\n${stderr}`));
    });
  });
}

/** One WebSocket frame, unmasked - which is what a server sends. */
function wsFrame(payload, opcode) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  if (data.length > 125) throw new Error("this fixture only sends small frames");
  return Buffer.concat([Buffer.from([0x80 | opcode, data.length]), data]);
}

/**
 * Pull whole frames out of a buffer, leaving any partial one behind.
 *
 * Client frames are always masked, which is the half of the protocol a server
 * has to implement to read anything at all.
 */
function wsParse(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    }

    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    if (masked) cursor += 4;
    if (cursor + length > buffer.length) break;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }

    frames.push({ opcode, payload });
    offset = cursor + length;
  }

  return { frames, rest: buffer.subarray(offset) };
}
