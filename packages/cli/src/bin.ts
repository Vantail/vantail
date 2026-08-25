#!/usr/bin/env node
/**
 * The `vantail` command.
 *
 * Four verbs, no plugins, no config file for the CLI itself. Everything it
 * needs to know is in `vantail.config.ts`.
 */

import { boolFlag, numberFlag, parseArgs, stringFlag } from "./args.js";
import { build } from "./commands/build.js";
import { dev } from "./commands/dev.js";
import { doctor } from "./commands/doctor.js";
import { packageApp } from "./commands/package.js";
import { keygen, manifest, sign } from "./commands/updater.js";
import { ConfigErrorName, VERSION } from "./index.js";
import { log, style } from "./log.js";

const HELP = `
${style.bold("vantail")} ${style.dim(VERSION)} - a thin native layer for JavaScript applications

${style.bold("USAGE")}
  vantail <command> [options]

${style.bold("COMMANDS")}
  dev        Run the app in a native window against the Vite dev server
  build      Build the web assets
  package    Build and lay out a distributable application
  doctor     Check that everything needed to run is present
  updater    Signing keys and release manifests for the self-updater

${style.bold("OPTIONS")}
  -c, --config <path>   Path to vantail.config.ts (found automatically otherwise)
      --port <number>   Dev server port
      --host <host>     Dev server host
      --mode <mode>     Vite mode for build (default: production)
      --no-build        package: use the existing build output
      --out-dir <path>  package: where to write the bundle
      --sign <identity> package: macOS codesign identity (default: ad-hoc)
      --update          package: also write the .tar.gz the updater downloads
      --installer       package: also build a .dmg, .msi or .deb
      --allow-debug-runtime
                        package: allow a debug runtime (about 10x the size)
      --key <path>      updater: signing key (default: .vantail/updater.key,
                        or $VANTAIL_UPDATER_KEY)
      --base-url <url>  updater manifest: where the archives will be served
      --notes <text>    updater manifest: release notes
      --date <iso>      updater manifest: publication timestamp
      --out <path>      updater: output path
  -v, --version         Print the version
  -h, --help            Print this message

${style.bold("UPDATER")}
  vantail updater keygen
  vantail updater sign <file>
  vantail updater manifest <target>=<archive> [...] --base-url https://...

${style.bold("EXAMPLES")}
  vantail dev
  vantail build --mode staging
  vantail package --sign "Developer ID Application: Jane Doe (ABCDE12345)"
  vantail package --update --installer
  vantail updater manifest darwin-aarch64=build/darwin/App-1.1.0-darwin-aarch64.tar.gz \\
    --base-url https://downloads.example.com/1.1.0
`.trim();

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  if (boolFlag(args, "version", "v") || args.command === "version") {
    console.log(VERSION);
    return 0;
  }

  if (args.command === undefined || args.command === "help" || boolFlag(args, "help", "h")) {
    console.log(HELP);
    return args.command === undefined ? 1 : 0;
  }

  const config = stringFlag(args, "config", "c");

  switch (args.command) {
    case "dev":
      return dev({
        cwd,
        ...(config ? { config } : {}),
        ...(numberFlag(args, "port") !== undefined ? { port: numberFlag(args, "port")! } : {}),
        ...(stringFlag(args, "host") ? { host: stringFlag(args, "host")! } : {}),
      });

    case "build":
      await build({
        cwd,
        ...(config ? { config } : {}),
        ...(stringFlag(args, "mode") ? { mode: stringFlag(args, "mode")! } : {}),
      });
      return 0;

    case "package":
      return packageApp({
        cwd,
        ...(config ? { config } : {}),
        ...(boolFlag(args, "build") === false ? { skipBuild: true } : {}),
        ...(stringFlag(args, "out-dir") ? { outDir: stringFlag(args, "out-dir")! } : {}),
        ...(stringFlag(args, "sign") ? { sign: stringFlag(args, "sign")! } : {}),
        ...(boolFlag(args, "update") ? { update: true } : {}),
        ...(boolFlag(args, "installer") ? { installer: true } : {}),
        ...(boolFlag(args, "allow-debug-runtime") ? { allowDebugRuntime: true } : {}),
      });

    case "doctor":
      return doctor({ cwd, ...(config ? { config } : {}) });

    case "updater":
      return updaterCommand(args, cwd, config);

    default:
      log.error(`Unknown command "${args.command}". Try \`vantail help\`.`);
      return 1;
  }
}

/** `vantail updater <keygen|sign|manifest>`. */
async function updaterCommand(
  args: ReturnType<typeof parseArgs>,
  cwd: string,
  config: string | undefined,
): Promise<number> {
  const [subcommand, ...rest] = args.positional;
  const key = stringFlag(args, "key");
  const out = stringFlag(args, "out");

  switch (subcommand) {
    case "keygen":
      return keygen({
        cwd,
        ...(out ? { out } : {}),
        ...(boolFlag(args, "force") ? { force: true } : {}),
      });

    case "sign": {
      const file = rest[0];
      if (!file) {
        log.error("vantail updater sign <file>");
        return 1;
      }
      return sign({ cwd, file, ...(key ? { key } : {}) });
    }

    case "manifest": {
      if (rest.length === 0) {
        log.error("vantail updater manifest <target>=<archive> [...] [--base-url <url>]");
        return 1;
      }
      return manifest({
        cwd,
        artifacts: rest,
        ...(config ? { config } : {}),
        ...(key ? { key } : {}),
        ...(out ? { out } : {}),
        ...(stringFlag(args, "base-url") ? { baseUrl: stringFlag(args, "base-url")! } : {}),
        ...(stringFlag(args, "notes") ? { notes: stringFlag(args, "notes")! } : {}),
        ...(stringFlag(args, "date") ? { date: stringFlag(args, "date")! } : {}),
      });
    }

    default:
      log.error(
        `Unknown updater command "${subcommand ?? ""}". Try keygen, sign or manifest.`,
      );
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // A config problem is the user's typo, not a crash - no stack trace.
    if (error instanceof Error && error.name === ConfigErrorName) {
      log.error(error.message);
    } else if (error instanceof Error) {
      log.error(error.message);
      if (process.env["VANTAIL_DEBUG"]) console.error(error.stack);
    } else {
      log.error(String(error));
    }
    process.exitCode = 1;
  });
