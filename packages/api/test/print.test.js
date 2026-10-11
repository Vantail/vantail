/**
 * `print.document` against a fake bridge.
 *
 * No window and no runtime involved: this checks the SDK half - that an
 * explicit source is required before anything is sent, and that a valid call
 * carries the method and params the runtime expects.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const posted = [];
let respond = () => ({ result: { printed: true } });
const listeners = new Set();

globalThis.__VANTAIL__ = {
  version: "0.1.0-test",
  label: "main",
  app: {
    name: "Test App",
    version: "1.2.3",
    identifier: "dev.vantail.test",
    isDev: true,
    platform: "macos",
    arch: "arm64",
  },
  postMessage(message) {
    posted.push(message);
    queueMicrotask(() =>
      listeners.forEach((listener) => listener({ id: message.id, ...respond(message) })),
    );
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const { print, VantailError } = await import("../dist/index.js");

test("both or neither source rejects with INVALID_ARGUMENT", async () => {
  for (const options of [{}, { html: "<p>x</p>", pdfPath: "/tmp/x.pdf" }, { html: "" }]) {
    posted.length = 0;
    await assert.rejects(print.document(options), (error) => {
      assert.ok(VantailError.is(error, "INVALID_ARGUMENT"));
      return true;
    });
    assert.equal(posted.length, 0, "nothing may reach the runtime");
  }
});

test("missing, null, and mistyped sources reject without sending", async () => {
  // No argument at all must reject with INVALID_ARGUMENT, not throw a
  // TypeError reading a property off `undefined`.
  const cases = [
    undefined,
    null,
    { html: "" },
    { pdfPath: "" },
    { html: "", pdfPath: "" },
    { html: 123 },
    { html: null },
    { html: ["<p>x</p>"] },
    { pdfPath: 42 },
    { pdfPath: null },
    { pdfPath: false },
  ];
  for (const options of cases) {
    posted.length = 0;
    await assert.rejects(print.document(options), (error) => {
      assert.ok(
        VantailError.is(error, "INVALID_ARGUMENT"),
        `expected INVALID_ARGUMENT for ${JSON.stringify(options)}, got ${String(error)}`,
      );
      return true;
    });
    assert.equal(posted.length, 0, "nothing may reach the runtime");
  }
});

test("whitespace-only html is an explicit source, not an absent one", async () => {
  // Only emptiness is filtered: a blank page still names its content, and
  // refusing it would second-guess the caller (a separator page, say).
  posted.length = 0;
  await print.document({ html: "   " });
  assert.deepEqual(posted.at(-1).params, { html: "   " });
});

test("unknown fields are stripped before sending", async () => {
  posted.length = 0;
  await print.document({ html: "<p>x</p>", copies: 2, title: "sneaky" });
  assert.deepEqual(posted.at(-1).params, { html: "<p>x</p>" });
});

test("an html call carries the method and params the runtime expects", async () => {
  posted.length = 0;
  const result = await print.document({ html: "<h1>hi</h1>" });
  assert.deepEqual(posted.at(-1), {
    id: posted.at(-1).id,
    method: "print.document",
    params: { html: "<h1>hi</h1>" },
  });
  assert.deepEqual(result, { printed: true });
});

test("a pdfPath call sends only the path", async () => {
  posted.length = 0;
  await print.document({ pdfPath: "/tmp/invoice.pdf" });
  assert.deepEqual(posted.at(-1).params, { pdfPath: "/tmp/invoice.pdf" });
});
