/**
 * The showcase example is supposed to demonstrate everything.
 *
 * "Everything" rots quietly: an API gets added, the example does not, and the
 * one place someone looks to see what Vantail can do is silently a version
 * behind. So the claim is checked rather than trusted.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const showcase = join(root, "examples", "showcase");

/** Every value `@vantail/api` exports, under the name a consumer would use. */
async function publicApi() {
  const source = await readFile(join(root, "packages/api/src/index.ts"), "utf8");

  return [
    ...new Set(
      [...source.matchAll(/export \{([^}]*)\} from/gs)]
        .flatMap((match) => match[1].split(","))
        .map((name) => name.trim())
        // `export { type Foo }` is a type, not something to demonstrate.
        .filter((name) => name && !name.startsWith("type "))
        // `appWindow as window` is one API under two names.
        .map((name) => (name.includes(" as ") ? name.split(" as ")[1].trim() : name)),
    ),
  ];
}

async function showcaseSource() {
  const dir = join(showcase, "src", "panels");
  const panels = await Promise.all(
    (await readdir(dir)).map((file) => readFile(join(dir, file), "utf8")),
  );

  return [
    ...panels,
    await readFile(join(showcase, "src", "main.ts"), "utf8"),
    await readFile(join(showcase, "src", "ui.ts"), "utf8"),
  ].join("\n");
}

test("the showcase uses every API @vantail/api exports", async () => {
  const api = await publicApi();
  const source = await showcaseSource();

  const missing = api.filter((name) => !new RegExp(`\\b${name}\\b`).test(source));

  assert.deepEqual(
    missing,
    [],
    `the showcase does not demonstrate: ${missing.join(", ")}.\n` +
      "Add a panel for it, or a row to the panel it belongs in.",
  );
});

test("every panel it defines is actually shown", async () => {
  const dir = join(showcase, "src", "panels");
  const files = await readdir(dir);

  const defined = [];
  for (const file of files) {
    const source = await readFile(join(dir, file), "utf8");
    for (const match of source.matchAll(/export function (\w+)\(/g)) {
      defined.push(match[1]);
    }
  }

  const main = await readFile(join(showcase, "src", "main.ts"), "utf8");
  // A panel that is written but never added to the list is invisible, which
  // is the same as not having written it.
  const unused = defined.filter((name) => !main.includes(`${name}()`));

  assert.deepEqual(unused, [], `defined but never shown: ${unused.join(", ")}`);
});

test("it asks for permissions it can explain", async () => {
  const config = await readFile(join(showcase, "vantail.config.ts"), "utf8");

  // Granting everything is the point here, and also the thing most likely to
  // be copied into a real app by mistake, so the warning has to stay.
  assert.match(
    config,
    /deliberately the opposite of what an application should do/,
    "the config no longer warns that granting everything is not a pattern to copy",
  );
});
