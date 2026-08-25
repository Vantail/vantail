/**
 * The self-updater, from signing key to relaunched application.
 *
 * This is the path with the worst failure mode in the project: an update that
 * installs something it should not have, or one that leaves an application
 * unable to update ever again. It had been verified once by hand and by
 * nothing since, which is what this fixes.
 *
 * Everything real: a signing key, two packaged builds, an HTTP server, and
 * the runtime replacing itself on disk and starting the replacement.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

import { resolveRuntimeBinary } from "@vantail/runtime";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "packages", "cli", "dist");

/** Import a built file by path. Windows rejects a bare absolute path here. */
const load = (...parts) => import(pathToFileURL(join(cli, ...parts)).href);

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

/** The page each build runs. v1 drives the update; v2 announces itself. */
function page(version, reportPath, marker) {
  const driving = `
const check = await updater.check();
report.check = check;
await save();
if (!check.available) { await invoke("app.quit"); }

const progress = [];
report.download = await updater.download((p) => progress.push(p.downloaded));
report.sawProgress = progress.length > 0;
report.pending = await updater.pending();
await save();

await updater.install();
// install() never resolves: the process is replaced.
report.installReturned = true;
await save();`;

  const announcing = `
report.runningVersion = app.infoSync().version;
await save();
setTimeout(() => void invoke("app.quit"), 400);`;

  return `<!doctype html>
<meta charset="utf-8">
<body>
<script type="module">
import { app, invoke, updater, VantailError } from "./api/index.js";
// Whatever happens, stop: a hung page is a test timeout with nothing to read,
// and an exit with a missing report at least says where it got to.
setTimeout(() => void invoke("app.quit"), 45000);
const report = { version: ${JSON.stringify(version)}, marker: ${JSON.stringify(marker)} };
const save = () =>
  invoke("filesystem.writeText", {
    path: ${JSON.stringify(reportPath)},
    contents: JSON.stringify(report, null, 2),
  });

try {
${version === "1.0.0" ? driving : announcing}
} catch (error) {
  report.error = VantailError.is(error) ? { code: error.code, message: error.message } : String(error);
  await save();
  await invoke("app.quit");
}
</script>
</body>`;
}

/** Package one version of the application, returning where it landed. */
async function build(options) {
  const { root, version, reportPath, marker, outDir, update } = options;

  await writeFile(
    join(root, "vantail.config.ts"),
    `export default ${JSON.stringify(
      {
        app: {
          name: "UpdateTest",
          identifier: "dev.vantail.updatetest",
          version,
        },
        window: { width: 360, height: 240, visible: false },
        permissions: {
          updater: true,
          // The fixture directory, which is where the reports go. Getting
          // this wrong is silent: the page's own error handler cannot write
          // either, so the application simply never says anything.
          filesystem: { read: [`${root}/**`], write: [`${root}/**`] },
        },
        updater: {
          endpoint: `http://127.0.0.1:${options.port}/latest.json`,
          publicKey: options.publicKey,
        },
      },
      null,
      2,
    )};\n`,
  );
  await writeFile(
    join(root, "dist", "index.html"),
    page(version, reportPath, marker),
  );

  const { packageApp } = await load("index.js");
  await packageApp({
    cwd: root,
    skipBuild: true,
    outDir,
    ...(update ? { update: true } : {}),
  });

  const platformDir = join(root, outDir, process.platform);
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(platformDir);
  const bundle = entries.find(
    (entry) => entry.endsWith(".app") || !entry.includes("."),
  );
  const archive = entries.find((entry) => entry.endsWith(".tar.gz"));

  return {
    bundle: join(platformDir, bundle),
    archive: archive ? join(platformDir, archive) : undefined,
  };
}

/** Where the executable lives inside a packaged bundle. */
function executable(bundle) {
  return process.platform === "darwin"
    ? join(bundle, "Contents", "MacOS", "UpdateTest")
    : join(bundle, basename(bundle));
}

function launch(path, timeoutMs = 60_000) {
  return new Promise((done, fail) => {
    const child = spawn(path, [], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`the application did not finish in time\n${stderr}`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      done({ code, stderr });
    });
    child.once("error", fail);
  });
}

async function waitForFile(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(await readFile(path, "utf8"));
    await new Promise((wait) => setTimeout(wait, 150));
  }
  return undefined;
}

describe(
  "self-update",
  {
    skip: headless
      ? "needs a display"
      : !runtimePath
        ? "no runtime binary built"
        : false,
  },
  () => {
    let root;
    let served;
    let server;
    let port;
    let installed;
    let reportPath;
    let newVersionMarker;

    before(async () => {
      root = await mkdtemp(join(tmpdir(), "vantail-update-"));
      reportPath = join(root, "report.json");
      newVersionMarker = join(root, "updated.json");
      await mkdir(join(root, "dist"), { recursive: true });
      await cp(
        join(repoRoot, "packages", "api", "dist"),
        join(root, "dist", "api"),
        {
          recursive: true,
        },
      );

      served = join(root, "served");
      await mkdir(served, { recursive: true });

      server = createServer(async (request, response) => {
        try {
          const file = join(served, decodeURIComponent(request.url.slice(1)));
          const body = await readFile(file);
          response.writeHead(200, { "content-length": body.length });
          response.end(body);
        } catch {
          response.writeHead(404);
          response.end();
        }
      });
      await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
      port = server.address().port;

      const { generateKeys } = await load("updater-keys.js");
      const keys = generateKeys();
      process.env.VANTAIL_UPDATER_KEY = keys.privateKeyPem;

      // The newer build first: it is what the older one downloads.
      const next = await build({
        root,
        version: "1.1.0",
        reportPath: newVersionMarker,
        marker: "new",
        outDir: ".vantail/next",
        update: true,
        port,
        publicKey: keys.publicKey,
      });
      await cp(next.archive, join(served, basename(next.archive)));

      const { manifest } = await load("commands", "updater.js");
      await manifest({
        cwd: root,
        artifacts: [join(served, basename(next.archive))],
        baseUrl: `http://127.0.0.1:${port}`,
        out: join(served, "latest.json"),
        date: "2026-01-01T00:00:00Z",
        notes: "The newer one",
      });

      // Then the older build, which is the one actually run.
      const current = await build({
        root,
        version: "1.0.0",
        reportPath,
        marker: "old",
        outDir: ".vantail/current",
        port,
        publicKey: keys.publicKey,
      });

      // Installed somewhere of its own, since installing replaces it.
      installed = join(root, "installed");
      await mkdir(installed, { recursive: true });
      await cp(current.bundle, join(installed, basename(current.bundle)), {
        recursive: true,
        verbatimSymlinks: true,
      });
      installed = join(installed, basename(current.bundle));
    });

    after(async () => {
      server?.close();
      delete process.env.VANTAIL_UPDATER_KEY;
      if (root && !process.env.VANTAIL_KEEP) {
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 250,
        }).catch(() => {});
      }
    });

    it("checks, downloads, verifies, installs and relaunches", async () => {
      await rm(reportPath, { force: true });
      await rm(newVersionMarker, { force: true });

      const result = await launch(executable(installed));
      assert.equal(result.code, 0, result.stderr);

      const report = JSON.parse(await readFile(reportPath, "utf8"));
      assert.equal(report.error, undefined, JSON.stringify(report.error));

      assert.equal(report.check.available, true);
      assert.equal(report.check.version, "1.1.0");
      assert.equal(report.check.notes, "The newer one");
      assert.equal(report.download.ready, true);
      assert.equal(
        report.sawProgress,
        true,
        "download progress should be reported",
      );
      assert.deepEqual(report.pending, { ready: true, version: "1.1.0" });
      // install() replaces the process, so it must never come back.
      assert.equal(report.installReturned, undefined);

      // The replacement started itself and is the newer build.
      const relaunched = await waitForFile(newVersionMarker);
      assert.equal(relaunched?.runningVersion, "1.1.0");

      // And what is on disk is the new one, in the old one's place.
      const config = JSON.parse(
        await readFile(
          process.platform === "darwin"
            ? join(installed, "Contents", "Resources", "vantail.json")
            : join(installed, "resources", "vantail.json"),
          "utf8",
        ),
      );
      assert.equal(config.app.version, "1.1.0");
    });

    it("refuses an update that does not match the signing key", async () => {
      // Put the older build back, and corrupt what the server offers.
      await rm(installed, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 250,
      });
      const current = join(root, ".vantail/current", process.platform);
      const { readdir } = await import("node:fs/promises");
      const [name] = (await readdir(current)).filter(
        (entry) => !entry.includes(".tar.gz"),
      );
      await cp(join(current, name), installed, {
        recursive: true,
        verbatimSymlinks: true,
      });

      const archive = (await readdir(served)).find((entry) =>
        entry.endsWith(".tar.gz"),
      );
      const bytes = Buffer.from(await readFile(join(served, archive)));
      bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      await writeFile(join(served, archive), bytes);

      await rm(reportPath, { force: true });
      await rm(newVersionMarker, { force: true });

      const result = await launch(executable(installed));
      assert.equal(result.code, 0, result.stderr);

      const report = JSON.parse(await readFile(reportPath, "utf8"));
      // One flipped byte is enough, and the failure is a refusal rather than
      // a crash or a partial install.
      assert.equal(report.error?.code, "PERMISSION_DENIED");
      assert.match(
        report.error.message,
        /not signed by this application's key/,
      );

      // Nothing was installed and nothing relaunched.
      assert.equal(existsSync(newVersionMarker), false);
      const config = JSON.parse(
        await readFile(
          process.platform === "darwin"
            ? join(installed, "Contents", "Resources", "vantail.json")
            : join(installed, "resources", "vantail.json"),
          "utf8",
        ),
      );
      assert.equal(config.app.version, "1.0.0");
    });
  },
);
