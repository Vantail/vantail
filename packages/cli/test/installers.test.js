/**
 * The installer formats.
 *
 * `.deb` and `.msi` are built here on a Mac, which is the point: a Linux
 * package should not require a Debian box to produce. Both are checked
 * against tools that did not write them - `ar` and `tar` for the archive,
 * `xmllint` for the installer description.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";

import { buildDeb, debianArchitecture, debianName } from "../dist/installers/deb.js";
import { buildMsi, guidFrom, msiVersion } from "../dist/installers/msi.js";
import { buildIcons, encode } from "../dist/icons/index.js";

const scratch = [];
after(async () => {
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

/**
 * Whether a command exists.
 *
 * Running it and looking at the failure, rather than asking `which` - which
 * does not exist on Windows, and whose absence made this skip checks it was
 * meant to gate. A tool that runs and complains is present; only ENOENT means
 * missing.
 */
function have(command) {
  try {
    execFileSync(command, [], { stdio: "ignore" });
    return true;
  } catch (error) {
    return error.code !== "ENOENT";
  }
}

/** A stand-in for a packaged application. */
async function fixture() {
  const root = await temporary("vantail-installer-");
  const bundle = join(root, "My-App");
  await mkdir(join(bundle, "resources", "dist"), { recursive: true });
  await writeFile(join(bundle, "My-App"), "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(join(bundle, "My-App"), 0o755);
  await writeFile(join(bundle, "resources", "vantail.json"), "{}", "utf8");
  await writeFile(join(bundle, "resources", "dist", "index.html"), "<!doctype html>", "utf8");

  const size = 256;
  const pixels = new Uint8Array(size * size * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 106;
    pixels[index + 1] = 60;
    pixels[index + 2] = 232;
    pixels[index + 3] = 255;
  }
  const icons = buildIcons({ width: size, height: size, pixels });

  return {
    config: {
      app: { name: "My App", identifier: "dev.wissen.myapp", version: "1.2.0" },
    },
    root,
    bundlePath: bundle,
    outDir: join(root, "out"),
    fileStem: "My-App-1.2.0-linux-x86_64",
    icons,
  };
}

describe("deb", () => {
  let input;
  let output;

  before(async () => {
    input = await fixture();
    await mkdir(input.outDir, { recursive: true });
    output = (await buildDeb(input)).path;
  });

  it("names the file the way Debian does", () => {
    assert.match(output, /my-app_1\.2\.0_(amd64|arm64|i386)\.deb$/);
  });

  it("is an ar archive with the three members, in order", async () => {
    const bytes = await readFile(output);
    assert.equal(bytes.subarray(0, 8).toString("ascii"), "!<arch>\n");

    // Read the member names straight out of the headers rather than trusting
    // the writer that produced them.
    const names = [];
    let at = 8;
    while (at + 60 <= bytes.length) {
      const name = bytes.toString("ascii", at, at + 16).trim().replace(/\/$/, "");
      const size = Number.parseInt(bytes.toString("ascii", at + 48, at + 58).trim(), 10);
      names.push(name);
      at += 60 + size + (size % 2);
    }

    // dpkg requires exactly this order.
    assert.deepEqual(names, ["debian-binary", "control.tar.gz", "data.tar.gz"]);
  });

  it("system ar agrees", { skip: !have("ar") }, () => {
    // Windows' ar ends lines with CRLF, which is not a difference in the
    // archive - the .deb it read is the same one.
    const listed = execFileSync("ar", ["t", output], { encoding: "utf8" }).trim().split(/\r?\n/);
    assert.deepEqual(listed, ["debian-binary", "control.tar.gz", "data.tar.gz"]);
  });

  it("installs into the layout a desktop expects", { skip: !have("tar") }, async () => {
    const extracted = await temporary("vantail-deb-check-");
    execFileSync("ar", ["x", output, "data.tar.gz"], { cwd: extracted });
    const listed = execFileSync("tar", ["-tzf", join(extracted, "data.tar.gz")], {
      encoding: "utf8",
    });

    assert.match(listed, /\.\/usr\/bin\/my-app/);
    assert.match(listed, /\.\/usr\/lib\/my-app\/My-App/);
    assert.match(listed, /\.\/usr\/share\/applications\/my-app\.desktop/);
    // Icons at theme sizes, or the menu entry shows a blank square.
    assert.match(listed, /\.\/usr\/share\/icons\/hicolor\/256x256\/apps\/my-app\.png/);
    assert.match(listed, /\.\/usr\/share\/icons\/hicolor\/48x48\/apps\/my-app\.png/);
  });

  it("declares what it needs to start", async () => {
    const extracted = await temporary("vantail-deb-control-");
    execFileSync("ar", ["x", output, "control.tar.gz"], { cwd: extracted });
    const control = gunzipSync(await readFile(join(extracted, "control.tar.gz")));
    const text = control.toString("latin1");

    assert.match(text, /Package: my-app/);
    assert.match(text, /Version: 1\.2\.0/);
    assert.match(text, /libwebkit2gtk-4\.1-0/);
    assert.match(text, /Architecture: (amd64|arm64|i386)/);
  });

  it("turns any application name into a legal package name", () => {
    assert.equal(debianName("My App"), "my-app");
    assert.equal(debianName("Jeroen's Notes!"), "jeroen-s-notes");
    assert.equal(debianName("日本語"), "vantail-app");
    assert.equal(debianArchitecture("x64"), "amd64");
    assert.equal(debianArchitecture("arm64"), "arm64");
  });
});

describe("msi", () => {
  it("writes a description WiX could build, and says how", async () => {
    const input = await fixture();
    await mkdir(input.outDir, { recursive: true });
    await writeFile(join(input.outDir, `${input.fileStem}.ico`), input.icons.ico);

    const result = await buildMsi(input);
    // WiX only runs on Windows, so anywhere else this stops at the .wxs and
    // says what to run rather than reporting a failure.
    assert.equal(result.kind, "msi");
    if (result.note) {
      assert.match(result.path, /\.wxs$/);
      assert.match(result.note, /wix build/);
    }

    const wxs = await readFile(result.path.replace(/\.msi$/, ".wxs"), "utf8");
    assert.match(wxs, /Name="My App"/);
    assert.match(wxs, /Version="1\.2\.0"/);
    assert.match(wxs, /UpgradeCode="[0-9A-F-]{36}"/);
    // Every file in the bundle has to be listed, or it does not get installed.
    assert.match(wxs, /Source=".*My-App"/);
    assert.match(wxs, /Subdirectory="resources\\dist"/);
  });

  it("is well-formed XML", { skip: !have("xmllint") }, async () => {
    const input = await fixture();
    await mkdir(input.outDir, { recursive: true });
    const result = await buildMsi(input);
    const path = result.path.replace(/\.msi$/, ".wxs");
    // A malformed .wxs fails on a Windows machine at the worst moment.
    execFileSync("xmllint", ["--noout", path]);
  });

  it("fits a version into what Windows Installer accepts", () => {
    assert.equal(msiVersion("1.2.0"), "1.2.0");
    // Pre-release information has nowhere to go in an MSI version.
    assert.equal(msiVersion("1.2.0-beta.1"), "1.2.0");
    // The fields are one byte, one byte and two bytes.
    assert.equal(msiVersion("999.999.99999"), "255.255.65535");
  });

  it("derives a stable upgrade code from the identifier", () => {
    // Upgrades only line up if this never changes for a given application.
    assert.equal(guidFrom("dev.wissen.myapp"), guidFrom("dev.wissen.myapp"));
    assert.notEqual(guidFrom("dev.wissen.myapp"), guidFrom("dev.wissen.other"));
    assert.match(
      guidFrom("dev.wissen.myapp"),
      /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/,
    );
  });
});
