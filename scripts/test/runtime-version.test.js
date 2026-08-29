/**
 * Which published runtime version a release may reuse.
 *
 * A short piece of code with a long blast radius: whatever it returns becomes
 * the version every platform package is depended on at, so getting it wrong
 * means no binary resolves for anybody. It has happened - `[object Object]`
 * reached npm and every later release read it back and passed it on.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareVersions,
  isVersion,
  neverPublished,
  newestCommonVersion,
} from "../lib/runtime-version.mjs";

describe("what counts as a version", () => {
  it("does not accept something that merely survives String()", () => {
    // The exact value that reached npm, via `String({})`.
    assert.equal(isVersion("[object Object]"), false);
    assert.equal(isVersion(String({})), false);
    assert.equal(isVersion({}), false);
    assert.equal(isVersion(undefined), false);
    assert.equal(isVersion(""), false);
    assert.equal(isVersion("latest"), false);
  });

  it("accepts the versions this project publishes", () => {
    for (const version of ["0.1.5", "1.0.0", "0.1.9-dev.26", "2.3.4-rc.1"]) {
      assert.equal(isVersion(version), true, version);
    }
  });
});

describe("choosing the version to reuse", () => {
  it("takes the newest one every package actually has", () => {
    // Not the newest anybody has: the release declares them all at a single
    // version, so one package missing it fails the whole install.
    const version = newestCommonVersion({
      "@vantail/runtime-darwin-arm64": ["0.1.4", "0.1.5", "0.1.6"],
      "@vantail/runtime-linux-x64": ["0.1.4", "0.1.5"],
    });
    assert.equal(version, "0.1.5");
  });

  it("finds nothing when a package has never been published", () => {
    // Adding a variant puts the pipeline here, and the only correct answer is
    // to build the runtimes rather than point at something that is not there.
    const published = {
      "@vantail/runtime-darwin-arm64": ["0.1.5"],
      "@vantail/runtime-darwin-arm64-sqlcipher": [],
    };
    assert.equal(newestCommonVersion(published), undefined);
    assert.deepEqual(neverPublished(published), [
      "@vantail/runtime-darwin-arm64-sqlcipher",
    ]);
  });

  it("ignores versions that are not versions", () => {
    assert.equal(
      newestCommonVersion({
        "@vantail/runtime-darwin-arm64": ["[object Object]", "0.1.5"],
        "@vantail/runtime-linux-x64": ["[object Object]", "0.1.5"],
      }),
      "0.1.5",
    );
  });

  it("prefers a release over its own prereleases", () => {
    // "Reuse the last release" means the release, not the dev build that
    // happened to carry the same number.
    assert.equal(
      newestCommonVersion({
        a: ["0.1.8-dev.3", "0.1.8"],
        b: ["0.1.8-dev.3", "0.1.8"],
      }),
      "0.1.8",
    );
  });

  it("orders versions numerically, not as text", () => {
    const sorted = ["0.1.9", "0.1.10", "0.2.0"].sort(compareVersions);
    assert.deepEqual(sorted, ["0.2.0", "0.1.10", "0.1.9"]);
  });
});
