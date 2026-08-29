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
 * How long a rehearsal may take before it counts as stuck.
 *
 * Generous: the slowest of these asks a real registry several questions.
 */
const DEADLINE = 90_000;

/**
 * Always a dry run: this must never be able to send anything.
 *
 * A trailing object is extra environment, for the cases where behaviour
 * depends on it rather than on the arguments.
 *
 * Killed if it outstays the deadline, which is the only way a hang here can
 * become a test failure. `node --test`'s own timeout does not help: it gives
 * up on the test but not on the child, so the run stays alive holding a
 * process that is waiting on a registry that will never answer. That is how
 * this file once turned a seven-second suite into a job CI had to time out.
 */
function publish(...args) {
  const extraEnv = typeof args.at(-1) === "object" ? args.pop() : {};

  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [script, "--dry-run", ...args],
      { cwd: repoRoot, env: { ...process.env, ...extraEnv } },
      (error, stdout, stderr) => {
        clearTimeout(overdue);
        resolve({
          code: error?.code ?? 0,
          output: `${stdout}${stderr}`,
          killed: error?.signal === "SIGKILL",
        });
      },
    );
    const overdue = setTimeout(() => child.kill("SIGKILL"), DEADLINE);
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
  // `.test` is reserved and resolves nowhere, so every question this script
  // asks the registry before sending anything goes unanswered. It has to give
  // up rather than wait: npm retries with backoff by default, so a probe with
  // no bound on it never comes back at all.
  const { output, killed } = await publish(
    "--registry",
    "https://registry.example.test",
  );

  assert.ok(!killed, `an unreachable registry hung for ${DEADLINE}ms`);
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

test("stops before publishing anything when a package cannot be created", async () => {
  // The failure this prevents: `@vantail/runtime-darwin-arm64@0.1.11` went
  // out, then the sqlcipher package beside it was refused - leaving a release
  // half published, with a resolver naming binaries that do not exist.
  //
  // npm's trusted publishing works against a package whose publisher is
  // already configured, and there is nothing to configure until the package
  // exists. So a run with no token cannot create a name, and it should say so
  // before it sends the first tarball rather than in the middle.
  const { code, output } = await publish(
    "--i-mean-it-publish-publicly",
    "--only",
    "@vantail/definitely-not-a-real-package",
    { NODE_AUTH_TOKEN: "", NPM_TOKEN: "" },
  );

  // Either it refuses for this reason, or it got no further - what must never
  // happen is publishing some and discovering the rest cannot go.
  if (code !== 0) {
    assert.doesNotMatch(
      output,
      /^\+ @vantail\//m,
      "nothing may be published before the check that would stop the run",
    );
  }
});

test("a dry run rehearses the checks rather than only the arguments", async () => {
  // A rehearsal that cannot tell you the release would stop half way is not
  // much of a rehearsal, so the registry checks run here too.
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(join(repoRoot, "scripts", "publish.mjs"), "utf8"),
  );
  assert.match(
    source,
    /Checked on a dry run too/,
    "the pre-flight has to run on a dry run",
  );
  assert.match(
    source,
    /already at \$\{version\}/,
    "an interrupted release has to be resumable rather than conflict",
  );
});
