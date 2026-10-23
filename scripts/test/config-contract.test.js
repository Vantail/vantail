/**
 * The config is read twice, by two parsers that have to agree.
 *
 * `vantail.config.ts` is checked by the Zod schema in `@vantail/shared`, turned
 * into `vantail.json` by the CLI, and read again by serde in the runtime. Each
 * side has its own tests, and both can be right on their own while
 * disagreeing with each other: a key the schema accepts and the runtime
 * refuses fails at launch, after the CLI has already said yes; a key the
 * runtime knows and the schema does not is a setting nobody can reach.
 *
 * So every case here goes through the real pipeline - `parseConfig`, then
 * `buildRuntimeConfig`, then the runtime binary's own `--check` - and both
 * verdicts have to match. The cases are made to cover every key the schema
 * knows, and that coverage is checked rather than trusted.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { resolveRuntimeBinary } from "@vantail/runtime";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const built = (path) => import(pathToFileURL(join(root, path)).href);

const { configSchema, parseConfig } = await built("packages/shared/dist/schema.js");
const { buildRuntimeConfig } = await built("packages/cli/dist/runtime-config.js");

let runtimePath;
try {
  runtimePath = resolveRuntimeBinary({ cwd: root, prefer: "release" }).path;
} catch {
  runtimePath = undefined;
}

const app = { name: "Contract", identifier: "dev.vantail.contract" };

/** Every key the schema knows, in one config. */
const everything = {
  app: { ...app, version: "1.2.3", icon: "icon.png" },
  window: {
    title: "Contract",
    width: 800,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    maxWidth: 1600,
    maxHeight: 1200,
    x: 10,
    y: 20,
    resizable: true,
    maximized: false,
    fullscreen: false,
    decorations: true,
    backgroundColor: "#112233",
    titleBarStyle: "hidden",
    titleBarHeight: 40,
    titleBarButtons: "system",
    trafficLightPosition: { x: 12, y: 14 },
    scroll: false,
    animateZoom: true,
    borderRadius: { topLeft: 8, topRight: 8, bottomLeft: 0, bottomRight: 0 },
    transparent: false,
    alwaysOnTop: false,
    center: true,
    visible: true,
    closeBehavior: "hide",
  },
  permissions: {
    filesystem: {
      read: { allow: ["$APPDATA/**"], deny: ["$APPDATA/secret/**"] },
      write: { allow: ["$APPDATA/**"], deny: [] },
      grantFromDialog: true,
      grantFromDrop: true,
    },
    dialog: true,
    clipboard: { read: true, write: true },
    notification: true,
    os: true,
    window: true,
    shell: {
      allow: [
        {
          program: "git",
          args: ["status", { pattern: "^--[a-z-]+$" }],
          cwd: { allow: ["$HOME/**"], deny: [] },
        },
      ],
      open: ["https://**"],
    },
    sharedState: { read: true, write: ["demo.*"], persist: true },
    tray: true,
    shortcut: true,
    dragDrop: true,
    autostart: true,
    menu: true,
    updater: true,
    network: {
      allow: ["api.example.com"],
      deny: ["internal.example.com"],
      allowInvalidCertificates: ["device.local"],
      clientCertificates: [
        { hosts: ["api.example.com"], certificate: "client.pem", key: "client.key" },
      ],
      proxy: { url: "http://proxy.example.com:8080", for: ["api.example.com"] },
      grantFromPrompt: true,
    },
    secrets: true,
    // `true` needs the SQLCipher build of the runtime, which is a different
    // binary - the key is what is under test here, not the variant.
    database: { encryption: false },
    mdns: ["_http._tcp.local."],
    hid: [{ vendorId: 0x1234, productId: 0x5678, usagePage: 0xff00 }],
  },
  menu: [
    {
      type: "submenu",
      label: "File",
      enabled: true,
      items: [
        { id: "open", label: "Open", accelerator: "CmdOrCtrl+O", enabled: true },
        { type: "checkbox", id: "wrap", label: "Wrap", checked: true },
        { type: "separator" },
        { type: "predefined", item: "quit", label: "Quit Contract" },
      ],
    },
    // The same kinds at the top level too: the coverage check sees a nested
    // item under `items[]`, and these are where the schema lists the keys.
    { id: "save", label: "Save", accelerator: "CmdOrCtrl+S" },
    { type: "checkbox", id: "dark", label: "Dark", checked: false, accelerator: "Alt+D" },
    { type: "predefined", item: "copy" },
  ],
  tray: {
    icon: "tray.png",
    tooltip: "Contract",
    title: "C",
    iconAsTemplate: true,
    menu: [{ id: "show", label: "Show" }],
    leftClick: "menu",
    window: "main",
  },
  updater: {
    endpoint: "https://updates.example.com/{{target}}/{{currentVersion}}",
    publicKey: "MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=",
    timeoutMs: 30000,
  },
  protocols: ["contract"],
  singleInstance: true,
  quitOnLastWindowClosed: false,
  showInDock: true,
  macos: {
    microphoneUsageDescription: "To record notes.",
    cameraUsageDescription: "To scan codes.",
  },
  distDir: "dist",
  devtools: false,
  outDir: "out",
};

/**
 * Configs both sides accept. Between them they use every key the schema
 * knows; where a value can take more than one shape, the other shapes are
 * here too, because each shape is a separate branch in both parsers.
 */
const accepted = [
  ["the smallest config", { app }],
  ["every key at once", everything],
  [
    "the short forms",
    {
      app,
      window: { borderRadius: 12 },
      permissions: {
        filesystem: { read: true, write: ["$APPDATA/**"] },
        clipboard: true,
        shell: { open: true },
        database: true,
        mdns: true,
        hid: true,
      },
      menu: [{ id: "plain", label: "No type given" }],
    },
  ],
  [
    "everything switched off",
    {
      app,
      permissions: {
        filesystem: { read: false, write: false },
        clipboard: false,
        shell: { open: false },
        database: false,
        mdns: false,
        hid: false,
      },
    },
  ],
];

/**
 * Configs both sides refuse - a value of the wrong kind each. A misspelt key
 * is not listed here: every object gets one by machine, below.
 */
const refused = [
  ["an unknown title bar style", { app, window: { titleBarStyle: "transparent" } }],
  ["an unknown close behaviour", { app, window: { closeBehavior: "minimise" } }],
  ["a width that is not a number", { app, window: { width: "800" } }],
  ["a menu item with an unknown type", { app, menu: [{ type: "radio", id: "a", label: "A" }] }],
  ["persisted shared state nobody can write", { app, permissions: { sharedState: { read: true, persist: true } } }],
  ["a client certificate for nobody", { app, permissions: { network: { clientCertificates: [{ hosts: [], certificate: "c.pem", key: "c.key" }] } } }],
  ["a USB id out of range", { app, permissions: { hid: [{ vendorId: 0x10000 }] } }],
  ["an updater without a key", { app, updater: { endpoint: "https://updates.example.com" } }],
];

/**
 * What the schema refuses and the runtime deliberately lets through. The CLI
 * is where a mistake gets a friendly message before anything ships; the
 * runtime's job is to start, and for these it starts without the bad part
 * and says so, rather than leaving the application dead over a cosmetic
 * value. Each one is checked to still be true, so the list cannot go stale.
 */
const schemaOnly = [
  [
    "a negative corner radius",
    { app, window: { borderRadius: -1 } },
    "a radius of zero or less rounds nothing",
  ],
  [
    "a colour that is not #rgb or #rrggbb",
    { app, window: { backgroundColor: "red" } },
    "the platform's own background stays",
  ],
  [
    "an unknown predefined menu item",
    { app, menu: [{ type: "predefined", item: "explode" }] },
    "the item is left out of the menu, with a note on stderr",
  ],
  [
    "an accelerator that is not one",
    { app, menu: [{ type: "normal", id: "a", label: "A", accelerator: "Cmd+Banana" }] },
    "the item is left out of the menu, with a note on stderr",
  ],
];

/** Top-level keys the CLI uses itself and deliberately keeps out of `vantail.json`. */
const cliOnly = new Set(["macos", "outDir"]);

/** Every key path in a Zod schema, with `[]` for array elements. */
function schemaPaths(schema) {
  const out = new Set();
  const expanded = new Set();
  const walk = (node, path) => {
    const def = node._zod.def;
    switch (def.type) {
      case "object":
        for (const [key, value] of Object.entries(def.shape)) {
          const next = path ? `${path}.${key}` : key;
          out.add(next);
          walk(value, next);
        }
        break;
      case "optional":
      case "nullable":
      case "default":
      case "readonly":
        walk(def.innerType, path);
        break;
      case "union":
        for (const option of def.options) walk(option, path);
        break;
      case "array":
        walk(def.element, `${path}[]`);
        break;
      case "pipe":
        walk(def.in, path);
        break;
      case "lazy":
        // Menu items contain menu items. Once is enough to see every key.
        if (!expanded.has(node)) {
          expanded.add(node);
          walk(def.getter(), path);
        }
        break;
    }
  };
  walk(schema, "");
  return out;
}

/** Every key path a config value actually uses, in the same notation. */
function valuePaths(value, path = "", out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) valuePaths(item, `${path}[]`, out);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      const next = path ? `${path}.${key}` : key;
      out.add(next);
      valuePaths(inner, next, out);
    }
  }
  return out;
}

describe("the config contract", () => {
  let scratch;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "vantail-contract-"));
  });

  after(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  /** What the runtime says about a `vantail.json`. */
  async function check(name, json) {
    const file = join(scratch, `${name.replace(/[^a-z0-9]+/gi, "-")}.json`);
    await writeFile(file, JSON.stringify(json), "utf8");
    try {
      await run(runtimePath, ["--check", "--config", file]);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error.stderr?.trim() || error.message };
    }
  }

  /** What the runtime says about the `vantail.json` the CLI would write. */
  function runtimeVerdict(name, config) {
    return check(name, buildRuntimeConfig({ config, root: scratch }));
  }

  it("covers every key the schema knows", () => {
    const used = new Set();
    for (const [, config] of accepted) {
      for (const path of valuePaths(config)) used.add(path);
    }
    const missing = [...schemaPaths(configSchema)].filter((path) => !used.has(path));

    assert.deepEqual(
      missing,
      [],
      `no accepted case uses: ${missing.join(", ")}.\n` +
        "Add it to `everything`, or to a case of its own if it is another shape of a value.",
    );
  });

  it("carries every top-level key into vantail.json, or says why not", () => {
    const parsed = parseConfig(everything);
    assert.ok(parsed.ok, parsed.problems?.join("\n"));
    const generated = buildRuntimeConfig({ config: parsed.config, root: "/project" });

    const dropped = Object.keys(configSchema._zod.def.shape).filter(
      (key) => !(key in generated) && !cliOnly.has(key),
    );
    assert.deepEqual(
      dropped,
      [],
      `buildRuntimeConfig drops: ${dropped.join(", ")}.\n` +
        "Pass it through to the runtime, or add it to `cliOnly` if only the CLI uses it.",
    );
  });

  for (const [name, config] of accepted) {
    it(`accepts ${name}`, { skip: !runtimePath && "no runtime binary built" }, async () => {
      const parsed = parseConfig(config);
      assert.ok(parsed.ok, `the schema refused it:\n${parsed.problems?.join("\n")}`);

      const verdict = await runtimeVerdict(name, parsed.config);
      assert.ok(verdict.ok, `the schema accepted it, the runtime refused it:\n${verdict.reason}`);
    });
  }

  for (const [name, config] of refused) {
    it(`refuses ${name}`, { skip: !runtimePath && "no runtime binary built" }, async () => {
      assert.equal(parseConfig(config).ok, false, "the schema accepted it");

      // What a hand-written vantail.json with the same mistake gets. The CLI
      // copies these sections through as written, so this is that file.
      const verdict = await runtimeVerdict(name, config);
      assert.equal(verdict.ok, false, "the schema refused it, the runtime accepted it");
    });
  }

  for (const [name, config, because] of schemaOnly) {
    it(`leaves ${name} to the schema`, { skip: !runtimePath && "no runtime binary built" }, async () => {
      assert.equal(parseConfig(config).ok, false, "the schema accepted it");
      const verdict = await runtimeVerdict(name, config);
      assert.ok(
        verdict.ok,
        `the runtime refuses this now - ${because} no longer holds.\n` +
          `Move it to \`refused\`:\n${verdict.reason}`,
      );
    });
  }

  // A misspelt key is the mistake that matters most, because a parser that
  // ignores it turns "I set that" into "nothing happened". So every object in
  // `everything`, at every depth, gets one - and both sides have to refuse it.
  const generated = buildRuntimeConfig({ config: everything, root: "/project" });
  for (const path of objectPaths(everything)) {
    const where = path.join(".") || "the top level";
    const cliOnlyKey = cliOnly.has(path[0]);
    it(`refuses an unknown key in ${where}`, { skip: !cliOnlyKey && !runtimePath && "no runtime binary built" }, async () => {
      assert.equal(parseConfig(withTypo(everything, path)).ok, false, "the schema accepted it");
      // The CLI never passes these on, so there is nothing for the runtime to refuse.
      if (cliOnlyKey) return;

      assert.ok(at(generated, path), `vantail.json has nothing at ${where} to put a typo in`);
      const verdict = await check(`typo ${where}`, withTypo(generated, path));
      assert.equal(verdict.ok, false, "the schema refused it, the runtime accepted it");
    });
  }
});

/** Where a config value holds an object, as key paths - the top level included. */
function objectPaths(value, path = [], out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => objectPaths(item, [...path, index], out));
  } else if (value && typeof value === "object") {
    out.push(path);
    for (const [key, inner] of Object.entries(value)) objectPaths(inner, [...path, key], out);
  }
  return out;
}

function at(value, path) {
  return path.reduce((node, key) => node?.[key], value);
}

function withTypo(value, path) {
  const copy = structuredClone(value);
  at(copy, path).contractTypo = true;
  return copy;
}
