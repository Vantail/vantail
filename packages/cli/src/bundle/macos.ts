/**
 * The macOS `.app` bundle.
 *
 * ```text
 * My App.app/
 *   Contents/
 *     Info.plist
 *     MacOS/My-App          <- the runtime binary
 *     Resources/
 *       vantail.json
 *       dist/...
 * ```
 *
 * The runtime finds its config at `../Resources/vantail.json` relative to its
 * own executable, so nothing here needs to be passed on a command line.
 */

import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../log.js";
import { writeRuntimeConfig } from "../runtime-config.js";
import { safeName, type BundleInput, type BundleResult } from "./common.js";

export async function writeMacBundle(input: BundleInput): Promise<BundleResult> {
  const displayName = input.config.app.name;
  const executableName = safeName(displayName);

  const app = join(input.outDir, `${displayName}.app`);
  const contents = join(app, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");

  await rm(app, { recursive: true, force: true });
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });

  const executable = join(macos, executableName);
  await cp(input.runtimePath, executable);
  await chmod(executable, 0o755);

  await cp(input.distDir, join(resources, "dist"), { recursive: true });

  if (input.icons) {
    await writeFile(join(resources, "icon.icns"), input.icons.icns);
  }

  await writeRuntimeConfig(join(resources, "vantail.json"), {
    config: input.config,
    root: input.root,
    distDir: "dist",
  });

  await writeFile(join(contents, "Info.plist"), infoPlist(input, executableName), "utf8");

  await sign(app, input.sign);

  return { path: app, kind: "app" };
}

function infoPlist(input: BundleInput, executableName: string): string {
  const { app } = input.config;
  const version = app.version ?? "0.0.0";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${escapeXml(app.name)}</string>
  <key>CFBundleDisplayName</key>
  <string>${escapeXml(app.name)}</string>
  <key>CFBundleIdentifier</key>
  <string>${escapeXml(app.identifier)}</string>
  <key>CFBundleExecutable</key>
  <string>${escapeXml(executableName)}</string>
  <key>CFBundleVersion</key>
  <string>${escapeXml(version)}</string>
  <key>CFBundleShortVersionString</key>
  <string>${escapeXml(version)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>${
    input.icons
      ? `
  <key>CFBundleIconFile</key>
  <string>icon</string>`
      : ""
  }
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
  <key>NSHighResolutionCapable</key>
  <true/>${urlTypes(input)}
</dict>
</plist>
`;
}

/**
 * Sign the bundle. An ad-hoc signature (`-`) is enough for the app to launch
 * on the machine that built it, which is what `vantail package` is for.
 * Shipping to other people needs a Developer ID identity and notarisation.
 */
async function sign(app: string, identity: string | undefined): Promise<void> {
  const chosen = identity ?? "-";
  const { spawn } = await import("node:child_process");

  const code = await new Promise<number>((resolve) => {
    const child = spawn("codesign", ["--force", "--sign", chosen, app], { stdio: "pipe" });
    child.once("error", () => resolve(-1));
    child.once("exit", (status) => resolve(status ?? -1));
  });

  if (code === 0) return;

  if (identity) {
    throw new Error(`codesign failed for identity "${identity}".`);
  }
  log.warn("could not apply an ad-hoc signature; the bundle may not launch on this Mac");
}

/**
 * Register the application's URL schemes.
 *
 * macOS reads these from the bundle, so `myapp://` only works once the app is
 * packaged - during `vantail dev` there is no bundle to register.
 */
function urlTypes(input: BundleInput): string {
  const protocols = input.config.protocols ?? [];
  if (protocols.length === 0) return "";

  const schemes = protocols
    .map((protocol) => `        <string>${escapeXml(protocol)}</string>`)
    .join("\n");

  return `
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>${escapeXml(input.config.app.identifier)}</string>
      <key>CFBundleTypeRole</key>
      <string>Viewer</string>
      <key>CFBundleURLSchemes</key>
      <array>
${schemes}
      </array>
    </dict>
  </array>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
