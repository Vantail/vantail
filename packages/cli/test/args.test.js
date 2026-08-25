import assert from "node:assert/strict";
import { test } from "node:test";

import { boolFlag, numberFlag, parseArgs, stringFlag } from "../dist/args.js";

test("reads the command and leaves the rest positional", () => {
  const args = parseArgs(["dev", "extra"]);
  assert.equal(args.command, "dev");
  assert.deepEqual(args.positional, ["extra"]);
});

test("accepts both --flag value and --flag=value", () => {
  assert.equal(stringFlag(parseArgs(["dev", "--port", "3000"]), "port"), "3000");
  assert.equal(stringFlag(parseArgs(["dev", "--port=3000"]), "port"), "3000");
});

test("short flags carry a following value", () => {
  assert.equal(stringFlag(parseArgs(["dev", "-c", "custom.ts"]), "config", "c"), "custom.ts");
});

test("a flag with nothing after it is a boolean", () => {
  assert.equal(boolFlag(parseArgs(["package", "--sign"]), "sign"), true);
});

test("--no-x sets x to false", () => {
  assert.equal(boolFlag(parseArgs(["package", "--no-build"]), "build"), false);
});

test("a flag is not swallowed by the next flag", () => {
  const args = parseArgs(["dev", "--host", "--port", "3000"]);
  assert.equal(boolFlag(args, "host"), true);
  assert.equal(stringFlag(args, "port"), "3000");
});

test("numeric flags are validated, not silently NaN", () => {
  assert.equal(numberFlag(parseArgs(["dev", "--port", "3000"]), "port"), 3000);
  assert.throws(() => numberFlag(parseArgs(["dev", "--port", "wide"]), "port"), /expects a number/);
});
