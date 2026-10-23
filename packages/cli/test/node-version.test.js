import assert from "node:assert/strict";
import { test } from "node:test";

import { NODE_REQUIREMENT, supportedNode } from "../dist/node-version.js";

test("accepts the first patched release on every supported line", () => {
  for (const version of ["22.23.4", "24.22.1", "26.12.1"]) {
    assert.equal(supportedNode(version), true, version);
  }
});

test("accepts later patches and minors on a supported line", () => {
  for (const version of ["22.23.5", "22.24.0", "24.22.2", "26.13.0"]) {
    assert.equal(supportedNode(version), true, version);
  }
});

test("rejects releases before the Brotli fix", () => {
  for (const version of ["22.23.3", "24.22.0", "26.12.0"]) {
    assert.equal(supportedNode(version), false, version);
  }
});

test("rejects end-of-life and odd-numbered lines", () => {
  for (const version of ["20.19.0", "21.7.3", "23.11.1", "25.0.0"]) {
    assert.equal(supportedNode(version), false, version);
  }
});

test("rejects something that is not a version", () => {
  assert.equal(supportedNode(""), false);
  assert.equal(supportedNode("not-a-version"), false);
});

test("the failure message names every minimum", () => {
  assert.equal(NODE_REQUIREMENT, "Node 22.23.4+, 24.22.1+ or 26.12.1+");
});
