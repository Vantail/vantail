/**
 * Native dialogs, driven by actually pressing keys.
 *
 * A file picker is a modal owned by the operating system, so there is no way
 * to test it from inside the application - the event loop is blocked while it
 * is open. This drives it the way a person would, through the accessibility
 * API, which is the only honest way to check the one behaviour that matters:
 * that a file the user chooses becomes readable even though the configuration
 * grants no standing access to it.
 *
 * macOS only. The same idea would work on Windows, but the automation is
 * different and this project has no Windows machine to write it on.
 *
 * **Opt in with `VANTAIL_UI_AUTOMATION=1`.** Keystrokes go to whichever
 * application is frontmost, and on a desktop someone is using, something else
 * takes the foreground often enough that this failed perhaps one run in five -
 * re-asserting focus before every keystroke and retrying a lost interaction
 * both helped, and neither made it dependable. A test that fails for reasons
 * unrelated to the code teaches people to ignore failures, so it stays out of
 * the default suite rather than being trusted less.
 *
 * What it proves that nothing else does is the whole path: a real NSOpenPanel,
 * a real choice, and a file that becomes readable because of it. The grant
 * logic underneath has its own tests in `permissions::tests`.
 *
 * Run it on an idle machine:
 *
 *   VANTAIL_UI_AUTOMATION=1 node --test test/integration/dialog.test.js
 */

import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { resolveRuntimeBinary } from "@vantail/runtime";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let runtimePath;
try {
  runtimePath = resolveRuntimeBinary({ cwd: repoRoot, prefer: "release" }).path;
} catch {
  runtimePath = undefined;
}

/**
 * Whether System Events can actually drive the UI.
 *
 * A CI runner has a window server but no logged-in session that has granted
 * accessibility permission, so scripting silently does nothing - which would
 * make this suite fail for a reason that has nothing to do with the code.
 */
function canScriptTheUi() {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync(
      "osascript",
      ["-e", 'tell application "System Events" to get name of first process'],
      { stdio: "ignore", timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

const skip =
  process.env.VANTAIL_SKIP_INTEGRATION === "1"
    ? "integration tests are off"
    : process.platform !== "darwin"
      ? "the automation here is macOS-only"
      : !runtimePath
        ? "no runtime binary built"
        : !process.env.VANTAIL_UI_AUTOMATION
          ? "set VANTAIL_UI_AUTOMATION=1 to run it, on a machine you are not using"
          : !canScriptTheUi()
            ? "needs an interactive session with accessibility permission"
            : false;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function osascript(script) {
  try {
    const { stdout } = await run("osascript", ["-e", script], {
      timeout: 15_000,
    });
    return stdout.trim();
  } catch (error) {
    return `error: ${error.message}`;
  }
}

/**
 * Poll a script until it answers `expect`.
 *
 * Every wait in here is on something observable - the panel exists, the sheet
 * is up, the sheet is gone. Sleeping a guessed number of milliseconds instead
 * made this suite fail perhaps one run in ten on a loaded machine.
 */
async function until(script, expect, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await osascript(script)) === expect) return true;
    await wait(150);
  }
  return false;
}

describe("native dialogs", { skip }, () => {
  let root;
  let secret;
  let resolved;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "vantail-dialog-"));
    await cp(
      join(repoRoot, "packages", "api", "dist"),
      join(root, "dist", "api"),
      {
        recursive: true,
      },
    );

    // Deliberately outside every scope the config grants.
    secret = join(root, "chosen.txt");
    await writeFile(secret, "the user picked this", "utf8");
    // macOS hands back the resolved path, and the temp directory is reached
    // through a symlink, so the two only compare equal after resolving.
    resolved = await realpath(secret);
  });

  after(async () => {
    if (root && !process.env.VANTAIL_KEEP) {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 250,
      }).catch(() => {});
    }
  });

  /**
   * Run one scripted interaction: the page performs `body`, and `drive` does
   * whatever a person would do to the dialog it opens.
   */
  /**
   * Losing the foreground is not a defect in what is being tested - it means
   * something else on the desktop took it - so it is worth another go with a
   * fresh process rather than a failed suite.
   */
  async function interact(body, drive, attempts = 3) {
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await attemptInteraction(body, drive);
      } catch (error) {
        if (
          !/came to the front|never opened|never closed|did not dismiss/.test(
            String(error?.message),
          )
        ) {
          throw error;
        }
        last = error;
      }
    }
    throw last;
  }

  async function attemptInteraction(body, drive) {
    const reportPath = join(root, "report.json");
    await rm(reportPath, { force: true });

    await writeFile(
      join(root, "vantail.json"),
      JSON.stringify({
        app: {
          name: "DialogTest",
          identifier: "dev.vantail.dialogtest",
          version: "1.0.0",
        },
        window: { width: 360, height: 240 },
        distDir: "dist",
        permissions: {
          dialog: true,
          filesystem: {
            // Nothing but the report file. Reading the chosen file has to come
            // from the dialog grant, not from here.
            read: [`${root}/report.json`],
            write: [`${root}/report.json`],
          },
        },
      }),
    );

    await writeFile(
      join(root, "dist", "index.html"),
      `<!doctype html>
<meta charset="utf-8">
<body>
<script type="module">
import { dialog, filesystem, invoke, VantailError } from "./api/index.js";
const report = {};
const save = () =>
  invoke("filesystem.writeText", {
    path: ${JSON.stringify(reportPath)},
    contents: JSON.stringify(report),
  });

setTimeout(() => void invoke("app.quit"), 40000);
try {
${body}
} catch (error) {
  report.error = VantailError.is(error) ? { code: error.code, message: error.message } : String(error);
}
await save();
await invoke("app.quit");
</script>
</body>`,
    );

    const child = spawn(runtimePath, ["--config", join(root, "vantail.json")], {
      stdio: "ignore",
    });
    // The dialog blocks the runtime's event loop while it is open, so the only
    // way to see it is to ask the window server about the process.
    const proc = `tell application "System Events" to tell (first process whose unix id is ${child.pid})`;

    try {
      assert.ok(
        await until(`${proc} to get (exists window "Open")`, "true"),
        "the file picker never opened",
      );
      /**
       * Send one keystroke, to this application.
       *
       * System Events delivers to whatever is frontmost *at that moment*, and
       * on a desktop in use something else can take the foreground part-way
       * through - a notification, a helper process launching. Re-asserting
       * before every keystroke is what stops a Return going to someone else's
       * window and the test failing for a reason that is not about Vantail.
       */
      const press = async (script) => {
        await osascript(`${proc} to set frontmost to true`);
        assert.ok(
          await until(
            `${proc} to get value of attribute "AXFrontmost"`,
            "true",
            10_000,
          ),
          "the application never came to the front, so keystrokes would go elsewhere",
        );
        return osascript(script);
      };

      await press(`${proc} to set frontmost to true`);
      await drive(proc, press);

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (existsSync(reportPath))
          return JSON.parse(await readFile(reportPath, "utf8"));
        await wait(200);
      }
      return undefined;
    } finally {
      child.kill("SIGKILL");
    }
  }

  it("a file the user picks becomes readable, though nothing granted it", async () => {
    const report = await interact(
      `
report.picked = await dialog.openFile({ title: "Pick" });
if (report.picked) {
  report.contents = await filesystem.readText(report.picked);
}`,
      async (proc, press) => {
        // "Go to folder", then the path, then choose it. The path is set on
        // the field rather than typed: typing races the sheet's animation, and
        // a half-delivered path silently picks the wrong file.
        await press(
          'tell application "System Events" to keystroke "g" using {command down, shift down}',
        );
        assert.ok(
          await until(
            `${proc} to get (exists sheet 1 of window "Open")`,
            "true",
          ),
          "the go-to-folder sheet never opened",
        );
        await osascript(
          `${proc} to set value of text field 1 of sheet 1 of window "Open" to ${JSON.stringify(secret)}`,
        );
        await press('tell application "System Events" to key code 36');
        assert.ok(
          await until(
            `${proc} to get (exists sheet 1 of window "Open")`,
            "false",
          ),
          "the go-to-folder sheet never closed",
        );
        await press('tell application "System Events" to key code 36');
      },
    );

    assert.ok(report, "the application never reported back");
    assert.equal(report.error, undefined, JSON.stringify(report.error));
    assert.equal(report.picked, resolved);
    // This is the whole point: the config grants no read access to this file,
    // and choosing it in the dialog is what made it readable.
    assert.equal(report.contents, "the user picked this");
  });

  it("cancelling resolves to null rather than throwing", async () => {
    const report = await interact(
      `
report.picked = await dialog.openFile({ title: "Cancel me" });
report.cancelled = report.picked === null;`,
      async (proc, press) => {
        await press('tell application "System Events" to key code 53');
        assert.ok(
          await until(`${proc} to get (exists window "Open")`, "false"),
          "escape did not dismiss the picker",
        );
      },
    );

    assert.ok(report, "the application never reported back");
    assert.equal(report.picked, null);
    assert.equal(report.cancelled, true);
  });

  // `dialog.message` and `dialog.confirm` are deliberately not driven here.
  // They render correctly - an alert with the right title, message and
  // buttons - but macOS does not expose an app-modal NSAlert through the
  // accessibility API, so System Events can neither see its buttons nor
  // deliver a keystroke to it. A test that cannot press the button is not a
  // test, so those two are checked by looking at the screen instead.
});
