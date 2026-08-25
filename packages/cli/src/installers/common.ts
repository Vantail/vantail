import type { ParsedConfig } from "@vantail/shared/load";

import type { IconSet } from "../icons/index.js";

export interface InstallerInput {
  config: ParsedConfig;
  /** Project root, for resolving anything the config names. */
  root: string;
  /** The `.app` or portable folder to wrap. */
  bundlePath: string;
  outDir: string;
  /** `My-App-1.2.0-darwin-aarch64`, without an extension. */
  fileStem: string;
  icons?: IconSet | undefined;
}

export interface InstallerResult {
  path: string;
  kind: "dmg" | "msi" | "deb";
  /** Set when the file was produced but a required tool was missing. */
  note?: string;
}
