/**
 * The macOS disk image.
 *
 * A `.dmg` is what a Mac user expects to download: mount it, drag the app to
 * the Applications alias sitting next to it, done. `hdiutil` does the actual
 * work, which is fine - it ships with every Mac and this only ever runs on
 * one, since the bundle it packages can only be built there anyway.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { cp } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import type { InstallerInput, InstallerResult } from "./common.js";

const run = promisify(execFile);

export async function buildDmg(input: InstallerInput): Promise<InstallerResult> {
  const volume = input.config.app.name;
  const output = resolve(input.outDir, `${input.fileStem}.dmg`);

  // hdiutil images the directory it is given, so the layout the user sees when
  // they mount it is built first.
  const staging = await mkdtemp(join(tmpdir(), "vantail-dmg-"));
  try {
    await cp(input.bundlePath, join(staging, basename(input.bundlePath)), {
      recursive: true,
      verbatimSymlinks: true,
    });
    // The drag target. A symlink rather than a copy, or the image would carry
    // a second copy of every application on the machine.
    await symlink("/Applications", join(staging, "Applications"));

    await rm(output, { force: true });
    await run("hdiutil", [
      "create",
      "-volname",
      volume,
      "-srcfolder",
      staging,
      "-ov",
      // UDZO is compressed and read-only, which is what a download should be.
      "-format",
      "UDZO",
      "-fs",
      "HFS+",
      output,
    ]);

    return { path: output, kind: "dmg" };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
