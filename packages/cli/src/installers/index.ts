/**
 * Turning a bundle into the thing a user downloads.
 *
 * One installer per platform, chosen by where the build is running: a `.dmg`
 * on macOS, an `.msi` on Windows, a `.deb` on Linux. Cross-building is not
 * offered because the bundle being wrapped can only be produced on its own
 * platform anyway.
 */

import { buildDeb } from "./deb.js";
import { buildDmg } from "./dmg.js";
import { buildMsi } from "./msi.js";
import type { InstallerInput, InstallerResult } from "./common.js";

export type { InstallerInput, InstallerResult };
export { debianName, debianArchitecture } from "./deb.js";
export { guidFrom, msiVersion } from "./msi.js";

export async function buildInstaller(
  input: InstallerInput,
  platform: NodeJS.Platform = process.platform,
): Promise<InstallerResult> {
  switch (platform) {
    case "darwin":
      return buildDmg(input);
    case "win32":
      return buildMsi(input);
    case "linux":
      return buildDeb(input);
    default:
      throw new Error(`There is no installer format for ${platform}`);
  }
}
