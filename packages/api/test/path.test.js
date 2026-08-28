/**
 * `path`, checked against Node's own implementation.
 *
 * The point of shipping this is that every application would otherwise write
 * it, and get Windows subtly wrong. Asserting my own idea of the answers
 * would reproduce exactly that mistake, so every case here is compared with
 * `node:path` - the semantics developers already expect.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import nodePath from "node:path";

const { path } = await import("../dist/index.js");

const FLAVOURS = [
  ["posix", path.posix, nodePath.posix],
  ["win32", path.win32, nodePath.win32],
];

function compare(operation, cases, apply) {
  for (const [name, ours, theirs] of FLAVOURS) {
    for (const input of cases) {
      const args = Array.isArray(input) ? input : [input];
      assert.equal(
        apply(ours, args),
        apply(theirs, args),
        `${name}.${operation}(${args.map((a) => JSON.stringify(a)).join(", ")})`,
      );
    }
  }
}

test("join matches node", () => {
  compare(
    "join",
    [
      ["/foo", "bar"],
      ["foo", "", "bar"],
      ["/", "foo"],
      ["a", "..", "b"],
      ["/a/b", "../c"],
      [""],
      ["a/", "b"],
      [".", "a"],
      ["..", "a"],
      ["a", "b", "c", "..", "..", "d"],
      ["/a//b", "c"],
      ["C:\\foo", "bar"],
      ["C:foo", "bar"],
      ["\\foo", "bar"],
    ],
    (api, args) => api.join(...args),
  );
});

test("normalize matches node", () => {
  compare(
    "normalize",
    [
      "",
      "/",
      "/foo/bar//baz/asdf/quux/..",
      "foo/bar/",
      "/foo/../..",
      "a/./b",
      "../../a",
      "/a/b/../../../c",
      "a//b///c",
      "./a/b",
      "C:\\temp\\\\foo\\bar\\..\\",
      "C:foo",
      "\\foo\\..\\bar",
      "a/b\\c",
    ],
    (api, [input]) => api.normalize(input),
  );
});

test("dirname matches node", () => {
  compare(
    "dirname",
    [
      "/foo/bar",
      "/foo",
      "foo",
      "/",
      "foo/bar/",
      "a//b",
      "",
      "/foo/bar/baz",
      "/foo/../bar",
      "C:\\foo\\bar",
      "C:\\foo",
      "C:\\",
      "foo\\bar",
    ],
    (api, [input]) => api.dirname(input),
  );
});

test("basename matches node", () => {
  compare(
    "basename",
    [
      "/foo/bar/baz.html",
      "/foo/bar/",
      "/",
      "",
      "a.txt",
      "C:\\foo\\bar.txt",
      "C:\\",
      ["/foo/bar/baz.html", ".html"],
      [".html", ".html"],
      ["a.txt", ".txt"],
      ["a.txt", ".md"],
    ],
    (api, [input, suffix]) => api.basename(input, suffix),
  );
});

test("extname matches node", () => {
  compare(
    "extname",
    [
      "index.html",
      "index.",
      "index",
      ".index",
      ".index.md",
      "/a/b.c/d",
      "/a/b.c/d.e",
      "C:\\a\\b.txt",
    ],
    (api, [input]) => api.extname(input),
  );
});

test("isAbsolute matches node", () => {
  compare(
    "isAbsolute",
    [
      "/foo",
      "foo",
      "",
      "./a",
      "C:\\foo",
      "C:foo",
      "\\foo",
      "\\\\server\\share\\a",
    ],
    (api, [input]) => api.isAbsolute(input),
  );
});

test("the separator is the platform's", () => {
  assert.equal(path.posix.sep, "/");
  assert.equal(path.win32.sep, "\\");
});

test("outside a runtime it is the posix flavour", () => {
  // `os.infoSync()` reads the injected bridge, which a plain browser - and
  // this test - does not have. POSIX is the right guess for both.
  assert.equal(path.sep, "/");
});

test("each flavour can reach the others", () => {
  // So `path.win32.join` works whichever platform `path` turned out to be.
  assert.equal(path.win32.posix.sep, "/");
  assert.equal(path.posix.win32.sep, "\\");
});

test("a path helper needs no runtime and no permission", () => {
  // Pure string work: it will happily build a path the application is not
  // allowed to read, and `filesystem` is what refuses it.
  assert.equal(path.join("/etc", "shadow"), "/etc/shadow");
});
