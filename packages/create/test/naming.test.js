import assert from "node:assert/strict";
import { test } from "node:test";

import { suggestIdentifier, toPackageName } from "../dist/naming.js";

test("an identifier suggestion is always reverse-DNS", () => {
  assert.equal(suggestIdentifier("My Notes"), "com.example.mynotes");
  assert.equal(suggestIdentifier("vantail-app"), "com.example.vantailapp");
  assert.equal(suggestIdentifier("日本語"), "com.example.app");
});

test("package names are npm-legal", () => {
  assert.equal(toPackageName("My Notes"), "my-notes");
  assert.equal(toPackageName("  Weird!!Name  "), "weird-name");
  assert.equal(toPackageName("!!!"), "vantail-app");
});
