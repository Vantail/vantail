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
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  // A trailing object is options: `cwd` if the run needs a working directory
  // of its own, everything else extra environment.
  const { cwd = repoRoot, ...extraEnv } =
    typeof args.at(-1) === "object" ? args.pop() : {};

  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [script, "--dry-run", ...args],
      { cwd, env: { ...process.env, ...extraEnv } },
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
 * A registry of our own, on the loopback address.
 *
 * Earlier versions of these tests pointed npm at `registry.example.test` and
 * read the failure text. That is not a registry, it is whatever the machine's
 * resolver decides to do with a name that does not exist - which is one thing
 * on a laptop, another on a Linux runner, and another again behind a resolver
 * that answers for everything. Nothing about npm's config handling depends on
 * DNS, so nothing here should either.
 *
 * `answer` decides what it is: a registry that has the packages published by a
 * trusted publisher, one whose packages were last published from an account,
 * one that has never heard of them, or - by never being started - one that
 * refuses the connection.
 */
function registryServing(answer) {
  const server = createServer((request, response) => {
    // Authentication has to fail, or the run takes itself for a logged-in
    // publisher and skips the very checks these tests are about.
    if (request.url.startsWith("/-/whoami")) {
      response.writeHead(401, { "content-type": "application/json" });
      return response.end(`{"error":"unauthenticated"}`);
    }
    if (answer === "missing") {
      response.writeHead(404, { "content-type": "application/json" });
      return response.end(`{"error":"Not found"}`);
    }
    // The smallest packument `npm view <name> version` will read.
    //
    // `_npmUser` is how the registry records who published a version, and a
    // trusted publisher leaves its mark there - which is the only thing that
    // distinguishes a name a release can publish from one it cannot.
    const name = decodeURIComponent(request.url.replace(/^\//, ""));
    const publisher =
      answer === "account"
        ? { name: "someone", email: "someone@example.com" }
        : {
            name: "GitHub Actions",
            email: "npm-oidc-no-reply@github.com",
            trustedPublisher: { id: "github" },
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name,
        "dist-tags": { latest: "9.9.9" },
        versions: {
          "9.9.9": { name, version: "9.9.9", _npmUser: publisher },
        },
      }),
    );
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

/**
 * A run that gets as far as asking the registry anything.
 *
 * Two things have to be arranged or it stops earlier than the code under test.
 * A home directory of its own, because an `.npmrc` in the real one can set the
 * very keys a bad config would collide with - which is exactly why the bad
 * config reached CI in the first place. And a directory standing in for a
 * built platform package, because the run refuses to go on with nothing to
 * publish against, and a developer's checkout has one lying about while a
 * fresh clone does not - so without this the test passes locally and tests
 * nothing on a runner.
 */
function probeRun(registry, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "vantail-npm-home-"));
  const packages = mkdtempSync(join(tmpdir(), "vantail-packages-"));
  mkdirSync(join(packages, "runtime-darwin-arm64"));

  // A working directory of its own, holding the scope mapping.
  //
  // `--registry` is not the last word for a scoped name: an `@vantail:registry`
  // line beats it outright, and npm reads one from the project `.npmrc` in the
  // working directory. The release job writes exactly such a file, pointing the
  // scope at npmjs - so a test run from the checkout would quietly ask the real
  // registry about the real packages and conclude whatever npmjs happened to
  // say. Running from elsewhere, with the mapping set here, is what makes the
  // registry named below the one that answers.
  const from = mkdtempSync(join(tmpdir(), "vantail-cwd-"));
  writeFileSync(join(from, ".npmrc"), `@vantail:registry=${registry}\n`);

  return publish("--registry", registry, "--partial", "--packages", packages, {
    cwd: from,
    HOME: home,
    USERPROFILE: home,
    npm_config_userconfig: join(home, ".npmrc"),
    ...extraEnv,
  });
}

/**
 * The registry probes have to hand npm a configuration it will accept.
 *
 * This is not hypothetical. A `--fetch-retry-maxtimeout` of 5s sat below npm's
 * own `fetch-retry-mintimeout` of 10s, so npm refused the config and failed
 * every `npm view` before it made a request. The script read that as "the
 * registry says no", and a release stopped dead insisting that six packages
 * which had been published for months did not exist.
 *
 * The registry here answers everything, so if the run cannot get an answer out
 * of it, the fault is on our side of the wire.
 */
test("hands npm a configuration it accepts", async () => {
  const registry = await registryServing("everything");
  try {
    const { output } = await probeRun(registry.url);

    assert.doesNotMatch(
      output,
      /minTimeout|Unknown user config|invalid config/i,
      "npm rejected the configuration the probes gave it",
    );
    assert.doesNotMatch(
      output,
      /Could not ask/,
      "the registry answered everything, so nothing should have gone unasked",
    );
    assert.doesNotMatch(output, /do not exist on .* yet/);
  } finally {
    await registry.close();
  }
});

/**
 * A registry that cannot be reached is not a registry that said no.
 *
 * The refusal exists to stop a release half way through; firing it on a
 * question that never got an answer stops a release that was fine.
 */
test("does not call a package missing when it could not ask", async () => {
  // Started and stopped, so it is a port nothing is listening on: the
  // connection is refused rather than left hanging.
  const registry = await registryServing("everything");
  await registry.close();

  const { output } = await probeRun(registry.url);

  assert.match(output, /Could not ask/, "the registry checks never ran");
  assert.doesNotMatch(
    output,
    /do not exist on .* yet/,
    "a registry it could not reach was read as an empty one",
  );
});

/**
 * When it could not ask, it has to say something worth reading.
 *
 * That message is the whole diagnostic for a release that stopped without
 * publishing, so it cannot be the first thing npm happened to print. npm
 * writes warnings to stderr alongside errors, and pnpm sets an env var that
 * makes npm lead with one - so this run once explained an unreachable registry
 * by complaining about `verify-deps-before-run`, on Linux only, while Windows
 * managed "no answer from npm" and macOS printed the truth.
 */
test("says why it could not ask, not whatever npm printed first", async () => {
  const registry = await registryServing("everything");
  await registry.close();

  const { output } = await probeRun(registry.url, {
    // Exactly what pnpm puts in the environment of anything it runs.
    npm_config_verify_deps_before_run: "false",
  });

  assert.match(output, /Could not ask/);
  assert.doesNotMatch(
    output,
    /- npm warn/,
    "a warning was reported as the reason the registry could not be asked",
  );
  assert.match(
    output,
    /ECONNREFUSED/,
    "the reason should be the failure npm actually hit",
  );
});

/**
 * A package the release cannot publish should be named before it tries.
 *
 * Trusted publishing is configured per package, so a scope that mostly works
 * can still hold one name that stops a release dead - and by then everything
 * ahead of it is public and cannot be taken back. That is not hypothetical: it
 * is how 0.1.15 got one platform package onto the registry and nothing else.
 *
 * A warning rather than a refusal, because the signal underneath - who
 * published the last version - is a good guess and not an answer. A name
 * configured since its last release looks like an account publish and is not.
 */
test("warns about packages a trusted publisher has not published", async () => {
  const registry = await registryServing("account");
  try {
    const { output, code } = await probeRun(registry.url);

    assert.equal(code, 0, "a warning must not stop the release on its own");
    assert.match(output, /Last published from an account/);
    assert.match(output, /@vantail\/shared/);
  } finally {
    await registry.close();
  }
});

test("says nothing when a trusted publisher published them", async () => {
  const registry = await registryServing("everything");
  try {
    const { output } = await probeRun(registry.url);

    assert.doesNotMatch(
      output,
      /Last published from an account/,
      "warned about packages that are already published the right way",
    );
  } finally {
    await registry.close();
  }
});

/**
 * And a registry that really does say no still stops the release.
 *
 * The other half of the same coin: having taught the script to tell silence
 * from a "no", the "no" has to still count. Trusted publishing cannot create a
 * name that does not exist yet, and finding that out half way through is how a
 * release ends up partly public.
 */
test("still refuses when the registry says the package is new", async () => {
  const registry = await registryServing("missing");
  try {
    const { output, code } = await probeRun(registry.url);

    assert.notEqual(code, 0, "the run should have stopped");
    assert.match(output, /do not exist on .* yet/);
    assert.match(output, /Nothing has been published by this run/);
  } finally {
    await registry.close();
  }
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
