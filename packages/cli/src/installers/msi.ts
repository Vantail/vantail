/**
 * The Windows installer.
 *
 * WiX turns a `.wxs` description into an `.msi`. The description is generated
 * here; building it needs the WiX toolset, which is a dotnet tool and only
 * runs on Windows - so on any other machine this writes the `.wxs` and says
 * what to run, rather than pretending it failed.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { safeName } from "../bundle/common.js";
import type { InstallerInput, InstallerResult } from "./common.js";

const run = promisify(execFile);

export async function buildMsi(input: InstallerInput): Promise<InstallerResult> {
  const output = resolve(input.outDir, `${input.fileStem}.msi`);
  const source = resolve(input.outDir, `${input.fileStem}.wxs`);

  await mkdir(input.outDir, { recursive: true });
  await writeFile(source, await wxs(input), "utf8");

  if (!(await hasWix())) {
    return {
      path: source,
      kind: "msi",
      note:
        "WiX is not installed, so only the .wxs was written. On Windows:\n" +
        "  dotnet tool install --global wix\n" +
        `  wix build "${source}" -o "${output}"`,
    };
  }

  await run("wix", ["build", source, "-o", output]);
  return { path: output, kind: "msi" };
}

async function hasWix(): Promise<boolean> {
  try {
    await run("wix", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the installer description.
 *
 * Every file in the bundle is listed explicitly. WiX can harvest a directory
 * instead, but that means shipping a second tool and a build step that reads
 * the disk twice; the bundle is small enough to enumerate.
 */
async function wxs(input: InstallerInput): Promise<string> {
  const { app } = input.config;
  const name = safeName(app.name);
  const version = msiVersion(app.version ?? "0.0.0");
  const files = await walk(input.bundlePath);

  const components = files
    .map((file, index) => {
      const target = relative(input.bundlePath, file).split(sep);
      const id = `file${index}`;
      return `      <File Id="${id}" Source="${escapeXml(file)}" Name="${escapeXml(
        target[target.length - 1]!,
      )}"${target.length > 1 ? ` Subdirectory="${escapeXml(target.slice(0, -1).join("\\"))}"` : ""} />`;
    })
    .join("\n");

  // A stable GUID per application, so an upgrade replaces rather than
  // installs alongside. Derived from the identifier for exactly that reason.
  const upgradeCode = guidFrom(app.identifier);

  return `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package
      Name="${escapeXml(app.name)}"
      Manufacturer="${escapeXml(app.identifier)}"
      Version="${version}"
      UpgradeCode="${upgradeCode}"
      Scope="perUser"
      Compressed="yes">

    <MajorUpgrade DowngradeErrorMessage="A newer version of ${escapeXml(
      app.name,
    )} is already installed." />
    <MediaTemplate EmbedCab="yes" />
${input.icons ? `    <Icon Id="AppIcon" SourceFile="${escapeXml(join(input.outDir, `${input.fileStem}.ico`))}" />\n    <Property Id="ARPPRODUCTICON" Value="AppIcon" />\n` : ""}
    <StandardDirectory Id="LocalAppDataFolder">
      <Directory Id="INSTALLFOLDER" Name="${escapeXml(name)}" />
    </StandardDirectory>

    <StandardDirectory Id="ProgramMenuFolder">
      <Directory Id="ShortcutFolder" Name="${escapeXml(app.name)}" />
    </StandardDirectory>

    <ComponentGroup Id="ApplicationFiles" Directory="INSTALLFOLDER">
${components}
    </ComponentGroup>

    <Component Id="StartMenuShortcut" Directory="ShortcutFolder" Guid="${guidFrom(
      `${app.identifier}.shortcut`,
    )}">
      <Shortcut Id="AppShortcut"
                Name="${escapeXml(app.name)}"
                Target="[INSTALLFOLDER]${escapeXml(name)}.exe"
                WorkingDirectory="INSTALLFOLDER"${input.icons ? '\n                Icon="AppIcon"' : ""} />
      <RemoveFolder Id="RemoveShortcutFolder" Directory="ShortcutFolder" On="uninstall" />
      <RegistryValue Root="HKCU"
                     Key="Software\\${escapeXml(app.identifier)}"
                     Name="installed"
                     Type="integer"
                     Value="1"
                     KeyPath="yes" />
    </Component>

${protocolComponents(input, name)}
    <Feature Id="Main">
      <ComponentGroupRef Id="ApplicationFiles" />
      <ComponentRef Id="StartMenuShortcut" />${(input.config.protocols ?? [])
        .map((protocol) => `\n      <ComponentRef Id="Protocol${escapeXml(componentId(protocol))}" />`)
        .join("")}
    </Feature>
  </Package>
</Wix>
`;
}

/**
 * Windows Installer versions are three numbers, and the third is capped at
 * 65535. A pre-release suffix has nowhere to go, so it is dropped - an `.msi`
 * of `1.2.0-beta.1` installs as `1.2.0`.
 */
export function msiVersion(version: string): string {
  const [major = "0", minor = "0", patch = "0"] = version.split("-")[0]!.split(".");
  const clamp = (value: string, limit: number) =>
    Math.min(Math.max(0, Number.parseInt(value, 10) || 0), limit);
  return `${clamp(major, 255)}.${clamp(minor, 255)}.${clamp(patch, 65535)}`;
}

/**
 * A GUID derived from a string, so the same application always produces the
 * same one and upgrades line up. Not a real UUIDv5 - it does not need to be
 * anything but stable and well-formed.
 */
export function guidFrom(seed: string): string {
  let hash = 0x811c9dc5;
  const bytes: number[] = [];
  for (let round = 0; round < 16; round += 1) {
    for (const character of `${seed}:${round}`) {
      hash ^= character.codePointAt(0)!;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    bytes.push(hash & 0xff);
  }

  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0"));
  // Stamped as version 4, variant 1, which is what tools expect to see.
  hex[6] = `4${hex[6]!.slice(1)}`;
  hex[8] = `${((Number.parseInt(hex[8]!, 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")}`;

  const joined = hex.join("");
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20, 32),
  ]
    .join("-")
    .toUpperCase();
}

/**
 * Register the application's URL schemes with Windows.
 *
 * Per user rather than per machine, matching the per-user install scope, so
 * the installer needs no elevation.
 */
function protocolComponents(input: InstallerInput, name: string): string {
  const protocols = input.config.protocols ?? [];
  if (protocols.length === 0) return "";

  return protocols
    .map(
      (protocol) => `
    <Component Id="Protocol${escapeXml(componentId(protocol))}" Directory="INSTALLFOLDER" Guid="${guidFrom(
      `${input.config.app.identifier}.protocol.${protocol}`,
    )}">
      <RegistryKey Root="HKCU" Key="Software\\Classes\\${escapeXml(protocol)}">
        <RegistryValue Type="string" Value="URL:${escapeXml(input.config.app.name)}" KeyPath="yes" />
        <RegistryValue Name="URL Protocol" Type="string" Value="" />
      </RegistryKey>
      <RegistryValue Root="HKCU"
                     Key="Software\\Classes\\${escapeXml(protocol)}\\shell\\open\\command"
                     Type="string"
                     Value="&quot;[INSTALLFOLDER]${escapeXml(name)}.exe&quot; &quot;%1&quot;" />
    </Component>`,
    )
    .join("");
}

/** WiX identifiers are letters, digits and underscores. */
function componentId(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

async function walk(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
