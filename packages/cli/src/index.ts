/**
 * `@vantail/cli` - the programmatic side of the command line.
 *
 * `defineConfig` lives here so that `vantail.config.ts` has exactly one import,
 * from the package the project already depends on to build itself.
 */

export { defineConfig } from "@vantail/shared";
export type {
  AppConfig,
  ClipboardPermissions,
  FilesystemPermissions,
  PathScope,
  PermissionsConfig,
  VantailConfig,
  WindowConfig,
} from "@vantail/shared";

export { build, type BuildOptions, type BuildResult } from "./commands/build.js";
export { dev, type DevOptions } from "./commands/dev.js";
export { doctor, type DoctorOptions } from "./commands/doctor.js";
export { packageApp, type PackageOptions } from "./commands/package.js";
export { bundle, type BundleInput, type BundleResult } from "./bundle/index.js";
export { buildRuntimeConfig, type RuntimeConfigInput } from "./runtime-config.js";

/** Kept in step with package.json by the release script. */
export const VERSION = "0.1.15";

/** `ConfigError` is thrown from a package the CLI does not re-export. */
export const ConfigErrorName = "ConfigError";
