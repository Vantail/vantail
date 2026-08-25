#!/usr/bin/env node
/**
 * `npm create @vantail my-app`
 *
 * Copies a template, fills in the two things that are actually specific to a
 * project - its name and its bundle identifier - and gets out of the way.
 */

import { cp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { suggestIdentifier, toPackageName } from "./naming.js";

const TEMPLATES = [
  { id: "react-ts", label: "React + TypeScript" },
  { id: "svelte-ts", label: "Svelte + TypeScript" },
  { id: "vue-ts", label: "Vue + TypeScript" },
  { id: "vanilla-ts", label: "Vanilla TypeScript" },
] as const;

type TemplateId = (typeof TEMPLATES)[number]["id"];

const templatesRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const [name, inline] = splitFlag(arg.slice(2));
      const next = argv[index + 1];
      if (inline !== undefined) {
        flags.set(name, inline);
      } else if (next !== undefined && !next.startsWith("-")) {
        flags.set(name, next);
        index += 1;
      } else {
        flags.set(name, "true");
      }
      continue;
    }
    positional.push(arg);
  }

  const interactive =
    process.stdin.isTTY === true && flags.get("yes") !== "true";
  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;

  try {
    // Only ask when the directory was not given on the command line.
    const asked =
      positional[0] ??
      (rl ? (await rl.question("Project directory: ")).trim() : "");
    const directory = asked === "" ? "vantail-app" : asked;

    const target = resolve(process.cwd(), directory);
    if (existsSync(target) && (await readdir(target)).length > 0) {
      console.error(`${directory} already exists and is not empty.`);
      return 1;
    }

    const template = await chooseTemplate(flags.get("template"), rl);
    const name = flags.get("name") ?? basename(target);
    const identifier = flags.get("identifier") ?? suggestIdentifier(name);

    await scaffold({ template, target, name, identifier });

    // Nothing is published to npm yet, so a project scaffolded from a checkout
    // has to point back at it or `npm install` cannot resolve anything.
    const root = flags.get("no-link") === "true" ? undefined : checkout();
    const linked = root ? await linkToCheckout(target, root) : [];

    console.log(`
Created ${name} in ${directory}

  cd ${directory}
  npm install
  npm run dev
`);

    if (linked.length > 0) {
      console.log(`${linked.join(" and ")} point at ${root}.`);
      console.log(
        `Build them there first: pnpm install && pnpm build && pnpm build:runtime\n`,
      );
    }
    return 0;
  } finally {
    rl?.close();
  }
}

interface ScaffoldInput {
  template: TemplateId;
  target: string;
  name: string;
  identifier: string;
}

async function scaffold(input: ScaffoldInput): Promise<void> {
  await cp(join(templatesRoot, input.template), input.target, {
    recursive: true,
  });

  // npm refuses to publish a file called `.gitignore`, so templates ship it
  // under a placeholder name.
  const placeholder = join(input.target, "_gitignore");
  if (existsSync(placeholder)) {
    await rename(placeholder, join(input.target, ".gitignore"));
  }

  await substitute(join(input.target, "package.json"), input);
  await substitute(join(input.target, "vantail.config.ts"), input);
  await substitute(join(input.target, "index.html"), input);
  await substitute(join(input.target, "README.md"), input);
}

/**
 * The Vantail checkout this scaffolder is running out of, if it is running out
 * of one rather than an installed package.
 */
function checkout(): string | undefined {
  let dir = templatesRoot;
  for (;;) {
    if (
      existsSync(join(dir, "runtime", "Cargo.toml")) &&
      existsSync(join(dir, "packages"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Point the `@vantail/*` dependencies at a local checkout.
 *
 * npm links a `file:` dependency rather than copying it, which is what makes
 * this work end to end: the runtime resolver walks up from the linked package
 * and finds the `cargo build` in the checkout's `target/`, so a scaffolded app
 * runs against a locally built runtime with nothing else configured.
 *
 * Returns the packages it rewrote.
 */
async function linkToCheckout(target: string, root: string): Promise<string[]> {
  const path = join(target, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    Record<string, string> | undefined
  >;
  const linked: string[] = [];

  for (const group of ["dependencies", "devDependencies"]) {
    const deps = manifest[group];
    if (!deps) continue;

    for (const name of Object.keys(deps)) {
      if (!name.startsWith("@vantail/")) continue;
      const local = join(root, "packages", name.slice("@vantail/".length));
      if (!existsSync(local)) continue;
      deps[name] = `file:${local}`;
      linked.push(name);
    }
  }

  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return linked;
}

/** Replace the two tokens templates are allowed to contain. */
async function substitute(path: string, input: ScaffoldInput): Promise<void> {
  if (!existsSync(path)) return;
  const source = await readFile(path, "utf8");
  const replaced = source
    .replaceAll("__APP_NAME__", input.name)
    .replaceAll("__PACKAGE_NAME__", toPackageName(input.name))
    .replaceAll("__APP_IDENTIFIER__", input.identifier);
  await writeFile(path, replaced, "utf8");
}

async function chooseTemplate(
  requested: string | undefined,
  rl: ReturnType<typeof createInterface> | null,
): Promise<TemplateId> {
  if (requested) {
    const match = TEMPLATES.find((template) => template.id === requested);
    if (!match) {
      throw new Error(
        `Unknown template "${requested}". Available: ${TEMPLATES.map((t) => t.id).join(", ")}`,
      );
    }
    return match.id;
  }

  if (!rl) return "react-ts";

  console.log("\nTemplate:");
  TEMPLATES.forEach((template, index) => {
    console.log(`  ${index + 1}. ${template.label}`);
  });

  const answer = (await rl.question("Choose [1]: ")).trim();
  const index = answer === "" ? 0 : Number(answer) - 1;
  return TEMPLATES[index]?.id ?? "react-ts";
}

function splitFlag(body: string): [string, string | undefined] {
  const equals = body.indexOf("=");
  return equals === -1
    ? [body, undefined]
    : [body.slice(0, equals), body.slice(equals + 1)];
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
