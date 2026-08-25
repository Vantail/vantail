#!/usr/bin/env node
/**
 * Turn built runtime binaries into publishable npm packages.
 *
 * The promise is that an application developer never compiles Rust, which
 * works because each platform's binary ships as its own package with `os` and
 * `cpu` set. npm then installs exactly one of them and skips the rest.
 *
 *   node scripts/build-platform-packages.mjs --binaries <dir> --out <dir>
 *
 * `--binaries` holds one subdirectory per Rust target triple, each containing
 * the executable - which is the shape a CI matrix produces when every job
 * uploads its build as an artifact named after its target.
 */

import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const binaries = resolve(flag("binaries", "dist-runtime"));
const out = resolve(flag("out", "dist-packages"));
const required = process.argv.includes("--all");

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

/** Where to point a reader. `repository` is an object, not a URL. */
const home =
  manifest.homepage ??
  manifest.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "") ??
  "https://github.com/Vantail/vantail";
const platforms = JSON.parse(
  await readFile(join(root, "packages/runtime/platforms.json"), "utf8"),
);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const built = [];
const missing = [];

for (const target of platforms.targets) {
  const executable = target.platform === "win32" ? "vantail-runtime.exe" : "vantail-runtime";
  const source = join(binaries, target.rust, executable);

  if (!existsSync(source)) {
    missing.push(target);
    continue;
  }

  // `@vantail/runtime-darwin-arm64` -> `runtime-darwin-arm64`
  const directory = join(out, target.package.replace("@vantail/", ""));
  await mkdir(join(directory, "bin"), { recursive: true });
  await copyFile(source, join(directory, "bin", executable));
  await chmod(join(directory, "bin", executable), 0o755);

  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: target.package,
        version: manifest.version,
        description: `The Vantail native runtime for ${target.platform} ${target.arch}.`,
        license: manifest.license ?? "MIT",
        repository: manifest.repository,
        // npm reads these and installs only the matching package, which is
        // what keeps five binaries from landing on one machine.
        os: [target.platform],
        cpu: [target.arch],
        files: ["bin"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    join(directory, "README.md"),
    `# ${target.package}\n\n` +
      `The [Vantail](${home}) native runtime for ${target.platform} ` +
      `${target.arch}: one executable, and nothing else.\n\n` +
      `You do not depend on this directly. \`@vantail/runtime\` declares every ` +
      `platform build as an optional dependency, and npm installs only the one ` +
      `matching the \`os\` and \`cpu\` fields here - which is what keeps five ` +
      `binaries from landing on one machine.\n\n` +
      `\`\`\`bash\nnpm create @vantail my-app\n\`\`\`\n`,
    "utf8",
  );

  built.push({ ...target, directory });
  console.log(`  ${target.package.padEnd(34)} ${target.rust}`);
}

if (missing.length > 0) {
  const names = missing.map((target) => target.rust).join(", ");
  if (required) {
    console.error(`\nMissing binaries for: ${names}`);
    console.error(`Expected them under ${binaries}/<target>/`);
    process.exit(1);
  }
  console.log(`\nSkipped (no binary): ${names}`);
}

if (built.length === 0) {
  console.error("No binaries found - nothing to package.");
  process.exit(1);
}

// `@vantail/runtime` resolves the binary at runtime, so it is the package that
// has to depend on them. Optional, so an install on an unsupported platform
// warns rather than fails.
const resolver = JSON.parse(await readFile(join(root, "packages/runtime/package.json"), "utf8"));
resolver.optionalDependencies = Object.fromEntries(
  platforms.targets.map((target) => [target.package, manifest.version]),
);
await writeFile(
  join(out, "runtime.optional-dependencies.json"),
  `${JSON.stringify(resolver.optionalDependencies, null, 2)}\n`,
  "utf8",
);

console.log(`\n${built.length} package(s) in ${out}`);
console.log("optionalDependencies written to runtime.optional-dependencies.json");
