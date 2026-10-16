/**
 * React adapter tests via renderToStaticMarkup (no browser needed).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AArrowDown, House, Icon, Rocket, Settings } from "../dist/react.js";
import { resetUnknownIconWarnings } from "../dist/shared.js";

function render(element) {
  return renderToStaticMarkup(element);
}

test("Icon renders the named Lucide artwork with defaults", () => {
  const html = render(React.createElement(Icon, { name: "house" }));
  assert.match(html, /^<svg/);
  assert.match(html, /data-icon="house"/);
  assert.match(html, /M15 21v-8/);
  assert.match(html, /width="24"/);
  assert.match(html, /aria-hidden="true"/);
});

test("Icon applies size, strokeWidth, color and label", () => {
  const html = render(
    React.createElement(Icon, {
      name: "settings",
      size: 20,
      strokeWidth: 1.5,
      color: "red",
      label: "Settings",
    }),
  );
  assert.match(html, /width="20"/);
  assert.match(html, /height="20"/);
  assert.match(html, /stroke-width="1\.5"/);
  assert.match(html, /stroke="red"/);
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="Settings"/);
  assert.doesNotMatch(html, /aria-hidden/);
});

test("Icon falls back on invalid size and strokeWidth", () => {
  const html = render(React.createElement(Icon, { name: "x", size: -3, strokeWidth: -1 }));
  assert.match(html, /width="24"/);
  assert.match(html, /stroke-width="2"/);
});

test("Icon escapes labels via React (no raw HTML injection)", () => {
  const html = render(
    React.createElement(Icon, { name: "bell", label: "<script>alert(1)</script>" }),
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /aria-label="&lt;script&gt;/);
});

test("unknown names render a placeholder and warn once", () => {
  const original = console.warn;
  const messages = [];
  console.warn = (message) => messages.push(String(message));
  try {
    const first = render(React.createElement(Icon, { name: "bogus-icon" }));
    const second = render(React.createElement(Icon, { name: "bogus-icon" }));
    assert.match(first, /data-unknown="true"/);
    assert.match(second, /data-unknown="true"/);
    assert.match(first, /^<svg/);
  } finally {
    console.warn = original;
    resetUnknownIconWarnings();
  }
  assert.equal(messages.length, 1);
});

test("static components draw the same artwork as Icon by name", () => {
  const viaStatic = render(React.createElement(House, { size: 20 }));
  const viaDynamic = render(React.createElement(Icon, { name: "house", size: 20 }));
  assert.equal(viaStatic, viaDynamic);
  assert.match(render(React.createElement(Settings)), /data-icon="settings"/);
});

test("className merges with the built-in class; extra props pass through", () => {
  const html = render(
    React.createElement(Icon, {
      name: "star",
      className: "favorite",
      "data-testid": "icon-star",
    }),
  );
  assert.match(html, /class="vantail-icon favorite"/);
  assert.match(html, /data-testid="icon-star"/);
});

test("React APIs work with icons outside the original subset", () => {
  const dynamic = render(React.createElement(Icon, { name: "rocket" }));
  assert.match(dynamic, /data-icon="rocket"/);
  assert.doesNotMatch(dynamic, /data-unknown/);

  const viaStatic = render(React.createElement(Rocket, { size: 20 }));
  const viaDynamic = render(React.createElement(Icon, { name: "rocket", size: 20 }));
  assert.equal(viaStatic, viaDynamic);

  assert.match(render(React.createElement(AArrowDown)), /data-icon="a-arrow-down"/);
});
