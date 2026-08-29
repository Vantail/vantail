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

const withMenu = (accelerator) => ({
  ...valid,
  menu: [
    {
      type: "submenu",
      label: "Run",
      items: [{ id: "run", label: "Run Suite", accelerator }],
    },
  ],
});

test("an accelerator the platform cannot parse is a config error", () => {
  // Found before a window exists, rather than at startup - where it used to
  // take the whole menu bar, Cmd-Q and Cmd-C included, down with it.
  const result = parseConfig(withMenu("CmdOrCtrl+Nonsense"));
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /Nonsense/);
  assert.match(result.problems.join("\n"), /not a key name/);
});

test("`Return` is accepted, because that is what the key says", () => {
  // The runtime rewrites it to `Enter`, so the config is legal.
  assert.equal(parseConfig(withMenu("CmdOrCtrl+Return")).ok, true);
  assert.equal(parseConfig(withMenu("CmdOrCtrl+Enter")).ok, true);
});

test("the ordinary accelerators are all accepted", () => {
  for (const accelerator of [
    "CmdOrCtrl+S",
    "Cmd+Shift+P",
    "Alt+Shift+F4",
    "Ctrl+Alt+Delete",
    "F5",
    "Shift+ArrowUp",
    "CommandOrControl+,",
    "Super+Space",
    "Option+PageDown",
  ]) {
    assert.equal(
      parseConfig(withMenu(accelerator)).ok,
      true,
      `${accelerator} should be valid`,
    );
  }
});

test("a modifier that is not one is named in the error", () => {
  const result = parseConfig(withMenu("Hyper+S"));
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /Hyper.*not a modifier/s);
});

test("an empty accelerator is a mistake rather than 'no shortcut'", () => {
  // Leaving the field out is how you say there is no shortcut.
  const result = parseConfig(withMenu(""));
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /cannot be empty/);
});

test("a checkbox item's accelerator is checked the same way", () => {
  const result = parseConfig({
    ...valid,
    menu: [
      {
        type: "submenu",
        label: "View",
        items: [
          { type: "checkbox", id: "wrap", label: "Wrap", accelerator: "Cmd+Retrun" },
        ],
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /Retrun/);
});

test("a client certificate has to say which hosts it is for", () => {
  const result = parseConfig({
    ...valid,
    permissions: {
      network: {
        allow: ["*"],
        clientCertificates: [
          { hosts: [], certificate: "$APPDATA/c.pem", key: "$APPDATA/c.key" },
        ],
      },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /hosts/);
});

test("client certificates and a proxy are accepted", () => {
  const result = parseConfig({
    ...valid,
    permissions: {
      network: {
        allow: ["*"],
        clientCertificates: [
          {
            hosts: ["*.bank.example"],
            certificate: "$APPDATA/client.pem",
            key: "$APPDATA/client.key",
          },
        ],
        proxy: { url: "http://127.0.0.1:8888", for: ["*.example.com"] },
      },
    },
  });
  assert.equal(result.ok, true);
});

test("a typo in the network permissions is not silently ignored", () => {
  const result = parseConfig({
    ...valid,
    permissions: { network: { allow: ["*"], proxxy: { url: "http://x" } } },
  });
  assert.equal(result.ok, false);
});

test("grantFromPrompt is a permission like any other", () => {
  const result = parseConfig({
    ...valid,
    permissions: {
      network: { allow: ["*.internal"], grantFromPrompt: true },
    },
  });
  assert.equal(result.ok, true);
});

test("the database capability is a permission like any other", () => {
  const ok = parseConfig({
    ...valid,
    permissions: {
      database: true,
      filesystem: { read: ["$APPDATA/**"], write: ["$APPDATA/**"] },
    },
  });
  assert.equal(ok.ok, true);

  // And it is off unless asked for, like every other capability.
  const typo = parseConfig({ ...valid, permissions: { datbase: true } });
  assert.equal(typo.ok, false);
});

test("the config type and the schema agree about network permissions", () => {
  // The schema accepted these before the TypeScript type did, so a valid
  // config was a type error. Both now know about all three.
  const result = parseConfig({
    ...valid,
    permissions: {
      network: {
        allow: ["*.bank.example"],
        grantFromPrompt: true,
        clientCertificates: [
          { hosts: ["*.bank.example"], certificate: "$APPDATA/c.pem", key: "$APPDATA/c.key" },
        ],
        proxy: { url: "http://127.0.0.1:8888" },
      },
    },
  });
  assert.equal(result.ok, true);
});

test("a database can ask for the encrypted runtime", () => {
  assert.equal(
    parseConfig({
      ...valid,
      permissions: { database: { encryption: true }, secrets: true },
    }).ok,
    true,
  );
  // Still a plain boolean, for the many applications that do not encrypt.
  assert.equal(parseConfig({ ...valid, permissions: { database: true } }).ok, true);
  // And a typo inside it is caught rather than ignored.
  assert.equal(
    parseConfig({ ...valid, permissions: { database: { encryptoin: true } } }).ok,
    false,
  );
});
