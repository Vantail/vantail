/**
 * The guards on the publish script.
 *
 * Releases go to npmjs, and a publish there cannot be undone. It is also where
 * npm goes when nothing says otherwise, so a missing `.npmrc` or a stray scope
 * setting reaches it by accident. The refusal is checked rather than assumed,
 * and so is the one flag that gets past it.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "scripts", "publish.mjs");

/**
 * Always a dry run: this must never be able to send anything.
 *
 * A trailing object is extra environment, for the cases where behaviour
 * depends on it rather than on the arguments.
 */
function publish(...args) {
  const extraEnv = typeof args.at(-1) === "object" ? args.pop() : {};

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, "--dry-run", ...args],
      { cwd: repoRoot, env: { ...process.env, ...extraEnv } },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, output: `${stdout}${stderr}` });
      },
    );
  });
}

for (const registry of [
  "https://registry.npmjs.org",
  "https://registry.npmjs.org/",
  "http://registry.npmjs.org/",
]) {
  test(`refuses to publish to ${registry}`, async () => {
    const { code, output } = await publish("--registry", registry);
    assert.notEqual(code, 0, "the script should have failed");
    assert.match(output, /Refusing to publish/);
  });
}

test("an empty --registry never publishes to the public one", async () => {
  const { output } = await publish("--registry", "");

  // Two outcomes are both correct, and which one depends on whether the
  // machine has a project `.npmrc` - a clean checkout does not, since it
  // holds a token. Either it falls back to whatever that file configures, or
  // it refuses. What it must never do is go ahead against npmjs unasked.
  assert.doesNotMatch(
    output,
    /npm publish --registry https:\/\/registry\.npmjs\.org/,
    "it would have published publicly",
  );
});

test("the flag is what lets a release reach npmjs", async () => {
  // The release workflow passes this. If the flag ever stopped working, every
  // release would fail at the last step, after the five native builds.
  const { output } = await publish(
    "--registry",
    "https://registry.npmjs.org",
    "--i-mean-it-publish-publicly",
  );

  assert.doesNotMatch(output, /Refusing to publish/);
  assert.match(output, /registry\.npmjs\.org/);
});

test("gets past the registry check for a private one", async () => {
  const { output } = await publish(
    "--registry",
    "https://registry.example.test",
  );
  // It stops later, on there being no built platform packages - which is proof
  // it accepted the registry and moved on.
  assert.doesNotMatch(output, /Refusing to publish/);
  assert.match(output, /registry\.example\.test/);
});

/**
 * Provenance is only possible where npm can attest from, and asking for it
 * anywhere else is a hard error rather than a warning. The first publish of a
 * package cannot use trusted publishing, so it happens from someone's machine
 * with a token - and that publish must not ask for provenance.
 */
test("asks for provenance on CI and not on a laptop", async () => {
  const npmjs = [
    "--registry",
    "https://registry.npmjs.org",
    "--i-mean-it-publish-publicly",
  ];

  const local = await publish(...npmjs);
  assert.doesNotMatch(
    local.output,
    /--provenance/,
    "a local publish asks for provenance, which npm refuses outright",
  );

  // The same command; only the environment differs.
  const ci = await publish(...npmjs, { GITHUB_ACTIONS: "true" });
  assert.match(ci.output, /Provenance: yes/);
});
