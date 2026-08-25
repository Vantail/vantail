import assert from "node:assert/strict";
import { test } from "node:test";

import { parseConfig } from "../dist/schema.js";

const valid = { app: { name: "My App", identifier: "dev.wissen.myapp" } };

test("the smallest possible config is valid", () => {
  const result = parseConfig(valid);
  assert.equal(result.ok, true);
});

test("an identifier has to be reverse-DNS", () => {
  const result = parseConfig({ app: { name: "A", identifier: "myapp" } });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /reverse-DNS/);
});

test("a typo in a key is an error, not a silently ignored setting", () => {
  const result = parseConfig({ ...valid, window: { widht: 900 } });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /window/);
});

test("problems name the path that is wrong", () => {
  const result = parseConfig({ ...valid, window: { width: -5 } });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /^window\.width:/);
});

test("every shape of filesystem scope is accepted", () => {
  for (const read of [true, false, ["$HOME/**"], { allow: ["$HOME/**"], deny: ["$HOME/.ssh/**"] }]) {
    const result = parseConfig({ ...valid, permissions: { filesystem: { read } } });
    assert.equal(result.ok, true, `rejected ${JSON.stringify(read)}`);
  }
});

test("clipboard permissions can be split or combined", () => {
  assert.equal(parseConfig({ ...valid, permissions: { clipboard: true } }).ok, true);
  assert.equal(parseConfig({ ...valid, permissions: { clipboard: { read: true } } }).ok, true);
  assert.equal(parseConfig({ ...valid, permissions: { clipboard: "yes" } }).ok, false);
});
