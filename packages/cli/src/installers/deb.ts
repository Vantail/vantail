/**
 * The Debian package.
 *
 * A `.deb` is an `ar` archive holding exactly three members in exactly this
 * order: a version marker, the metadata tarball, and the payload tarball.
 * All three are built here rather than shelled out to `dpkg-deb`, so a Linux
 * package can be produced from any machine - which matters, because the
 * alternative is that only a Debian box can cut a Linux release.
 */

import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { tarGzipContents } from "../bundle/archive.js";
import type { InstallerInput, InstallerResult } from "./common.js";
import { LINUX_SIZES } from "../icons/index.js";

/** What a Vantail application needs present to start on Debian or Ubuntu. */
const DEPENDS = [
  "libwebkit2gtk-4.1-0",
  "libgtk-3-0",
  "libayatana-appindicator3-1 | libappindicator3-1",
];

export async function buildDeb(input: InstallerInput): Promise<InstallerResult> {
  const name = debianName(input.config.app.name);
  const version = input.config.app.version ?? "0.0.0";
  const architecture = debianArchitecture(process.arch);
  const output = resolve(input.outDir, `${name}_${version}_${architecture}.deb`);

  const staging = await mkdtemp(join(tmpdir(), "vantail-deb-"));
  try {
    // /usr/lib/<name> holds the application; /usr/bin gets a launcher so it is
    // on PATH; the desktop entry and icons make it appear in the menu.
    const libDir = join(staging, "data/usr/lib", name);
    await mkdir(libDir, { recursive: true });
    await cp(input.bundlePath, libDir, { recursive: true });

    const binDir = join(staging, "data/usr/bin");
    await mkdir(binDir, { recursive: true });
    // A script rather than a symlink, so the archive needs no symlink support
    // and the launcher can be read by anyone wondering what it does.
    await writeFile(
      join(binDir, name),
      `#!/bin/sh\nexec /usr/lib/${name}/${name} "$@"\n`,
      "utf8",
    );
    await chmod(join(binDir, name), 0o755);

    const applications = join(staging, "data/usr/share/applications");
    await mkdir(applications, { recursive: true });
    await writeFile(join(applications, `${name}.desktop`), desktopEntry(input, name), "utf8");

    if (input.icons) {
      for (const size of LINUX_SIZES) {
        const image = input.icons.png.get(size);
        if (!image) continue;
        const directory = join(
          staging,
          "data/usr/share/icons/hicolor",
          `${size}x${size}`,
          "apps",
        );
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${name}.png`), image);
      }
    }

    const data = await tarGzipContents(join(staging, "data"));

    const controlDir = join(staging, "control");
    await mkdir(controlDir, { recursive: true });
    await writeFile(
      join(controlDir, "control"),
      controlFile({ name, version, architecture, input, installedSize: data.length }),
      "utf8",
    );
    const control = await tarGzipContents(controlDir);

    await writeFile(
      output,
      ar([
        // The order is part of the format, not a convention.
        { name: "debian-binary", data: Buffer.from("2.0\n", "ascii") },
        { name: "control.tar.gz", data: control },
        { name: "data.tar.gz", data },
      ]),
    );

    return { path: output, kind: "deb" };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function controlFile(options: {
  name: string;
  version: string;
  architecture: string;
  input: InstallerInput;
  installedSize: number;
}): string {
  const { name, version, architecture, input } = options;
  const description = `${input.config.app.name}\n A desktop application built with Vantail.`;

  return (
    [
      `Package: ${name}`,
      `Version: ${version}`,
      `Architecture: ${architecture}`,
      // Required by the format. There is nowhere better to get one from, and
      // an obviously-placeholder value beats a wrong one.
      `Maintainer: ${input.config.app.identifier}`,
      `Installed-Size: ${Math.max(1, Math.round(options.installedSize / 1024))}`,
      `Depends: ${DEPENDS.join(", ")}`,
      "Section: utils",
      "Priority: optional",
      `Description: ${description}`,
    ].join("\n") + "\n"
  );
}

function desktopEntry(input: InstallerInput, name: string): string {
  const protocols = input.config.protocols ?? [];

  return (
    [
      "[Desktop Entry]",
      "Type=Application",
      `Name=${input.config.app.name}`,
      // %U passes the URL along, which is how a deep link arrives here.
      `Exec=${name} %U`,
      `Icon=${name}`,
      "Terminal=false",
      "Categories=Utility;",
      // This is what makes the desktop hand `myapp://` links to us.
      ...(protocols.length > 0
        ? [`MimeType=${protocols.map((p) => `x-scheme-handler/${p}`).join(";")};`]
        : []),
    ].join("\n") + "\n"
  );
}

/**
 * The `ar` archive format: a magic line, then a 60-byte header before each
 * member, padded to an even length.
 */
function ar(members: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [Buffer.from("!<arch>\n", "ascii")];

  for (const member of members) {
    const header = Buffer.alloc(60, 0x20); // space-padded, per the format
    // No trailing slash. GNU ar terminates names with one and dpkg tolerates
    // it, but dpkg writes them without - and BSD ar, which is what macOS has,
    // will list a slash-terminated member and then fail to extract it.
    header.write(member.name.padEnd(16), 0, 16, "ascii");
    header.write("0".padEnd(12), 16, 12, "ascii"); // mtime, fixed for reproducibility
    header.write("0".padEnd(6), 28, 6, "ascii"); // owner
    header.write("0".padEnd(6), 34, 6, "ascii"); // group
    header.write("100644".padEnd(8), 40, 8, "ascii"); // mode
    header.write(String(member.data.length).padEnd(10), 48, 10, "ascii");
    header.write("`\n", 58, 2, "ascii"); // the end-of-header marker

    parts.push(header, member.data);
    if (member.data.length % 2 === 1) parts.push(Buffer.from([0x0a]));
  }

  return Buffer.concat(parts);
}

/** Debian package names are lowercase, and punctuation is a hyphen. */
export function debianName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9+.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
  return cleaned.length > 1 ? cleaned : "vantail-app";
}

export function debianArchitecture(arch: string): string {
  // Debian's names, not Node's.
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  if (arch === "ia32") return "i386";
  return arch;
}
