/**
 * Reading the runtime version out of the registry's answer.
 *
 * This is a short piece of code with a long blast radius: whatever it returns
 * becomes the version every platform package is depended on at, so getting it
 * wrong means no binary resolves for anybody. It has happened - `[object
 * Object]` reached npm and every later release read it back and passed it on.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isVersion, versionsFrom } from "../lib/runtime-version.mjs";

describe("reading the published runtime version", () => {
  it("reads the ordinary shape", () => {
    assert.deepEqual(
      versionsFrom({
        "@vantail/runtime-darwin-arm64": "0.1.5",
        "@vantail/runtime-linux-x64": "0.1.5",
      }),
      ["0.1.5"],
    );
  });

  it("reads the version-keyed shape npm uses for a multi-version spec", () => {
    // What comes back when the dist-tag is missing. Turning these into
    // strings is what produced `[object Object]`.
    assert.deepEqual(
      versionsFrom({
        "0.1.4": { "@vantail/runtime-darwin-arm64": "0.1.4" },
        "0.1.5": { "@vantail/runtime-darwin-arm64": "0.1.5" },
      }),
      ["0.1.4", "0.1.5"],
    );
  });

  it("does not turn an object into a version", () => {
    // The exact failure: a value that survives `String()` and means nothing.
    assert.equal(isVersion(String({})), false);
    assert.equal(isVersion("[object Object]"), false);
    assert.equal(isVersion(undefined), false);
    assert.equal(isVersion({}), false);
    assert.equal(isVersion(""), false);
  });

  it("accepts the versions this project actually publishes", () => {
    for (const version of ["0.1.5", "1.0.0", "0.1.9-dev.26", "2.3.4-rc.1"]) {
      assert.equal(isVersion(version), true, version);
    }
  });

  it("catches a registry answer that would publish nonsense", () => {
    // The end-to-end property: whatever shape npm replies in, nothing that is
    // not a version may get as far as a manifest.
    const nonsense = versionsFrom({
      "0.1.8": { "@vantail/runtime-darwin-arm64": {} },
    });
    assert.ok(nonsense.every((value) => !isVersion(value)));
  });
});
