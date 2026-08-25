/**
 * The SDK against a fake bridge.
 *
 * No window and no runtime involved: this checks the half of the contract
 * that lives in JavaScript - that calls carry the right method and params,
 * that errors arrive as `VantailError`, and that events reach listeners.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const posted = [];
let respond = () => ({ result: null });
const listeners = new Set();
const backlog = [];

function dispatch(message) {
  if (listeners.size === 0) {
    backlog.push(message);
    return;
  }
  for (const listener of [...listeners]) listener(message);
}

const bridge = {
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
    queueMicrotask(() => dispatch({ id: message.id, ...respond(message) }));
  },
  subscribe(listener) {
    listeners.add(listener);
    while (backlog.length) listener(backlog.shift());
    return () => listeners.delete(listener);
  },
};

const {
  app,
  appWindow,
  createWindow,
  currentWindow,
  deepLink,
  dialog,
  filesystem,
  getWindow,
  hid,
  invoke,
  isVantail,
  listen,
  listWindows,
  mdns,
  menu,
  network,
  notification,
  os,
  process: childProcess,
  runtimeVersion,
  secrets,
  shell,
  tray,
  updater,
  VantailError,
} = await import("../dist/index.js");
const { resetDeepLinkState } = await import("../dist/deeplink.js");

/** Capture the request the SDK produced for a call. */
async function callAndCapture(action, reply = () => ({ result: null })) {
  posted.length = 0;
  respond = reply;
  const value = await action();
  return { request: posted.at(-1), value };
}

test("without a runtime, every call fails with NO_RUNTIME", async () => {
  assert.equal(isVantail(), false);
  await assert.rejects(invoke("app.version"), (error) => {
    assert.ok(VantailError.is(error, "NO_RUNTIME"));
    assert.match(error.message, /vantail dev/);
    return true;
  });
});

test("the bridge is picked up once it exists", () => {
  globalThis.__VANTAIL__ = bridge;
  assert.equal(isVantail(), true);
  assert.equal(runtimeVersion(), "0.1.0-test");
});

test("a result comes back as the resolved value", async () => {
  const { value } = await callAndCapture(() => filesystem.readText("/a.txt"), () => ({
    result: "contents",
  }));
  assert.equal(value, "contents");
});

test("an error response rejects with a VantailError carrying the code", async () => {
  respond = () => ({
    error: { code: "PERMISSION_DENIED", message: "nope", data: { path: "/etc/passwd" } },
  });

  await assert.rejects(filesystem.readText("/etc/passwd"), (error) => {
    assert.ok(VantailError.is(error, "PERMISSION_DENIED"));
    assert.equal(error.message, "nope");
    assert.deepEqual(error.data, { path: "/etc/passwd" });
    assert.equal(VantailError.is(error, "NOT_FOUND"), false);
    return true;
  });
});

test("concurrent calls resolve to their own responses", async () => {
  respond = (message) => ({ result: message.params.path });

  const [a, b, c] = await Promise.all([
    filesystem.readText("/a"),
    filesystem.readText("/b"),
    filesystem.readText("/c"),
  ]);
  assert.deepEqual([a, b, c], ["/a", "/b", "/c"]);
});

test("every request carries a unique id", async () => {
  posted.length = 0;
  respond = () => ({ result: null });
  await Promise.all([app.version(), app.name(), app.identifier()]);
  assert.equal(new Set(posted.map((message) => message.id)).size, 3);
});

test("filesystem calls send the method and params the runtime expects", async () => {
  const write = await callAndCapture(() => filesystem.writeText("/a.txt", "hi"));
  assert.deepEqual(write.request, {
    id: write.request.id,
    method: "filesystem.writeText",
    params: { path: "/a.txt", contents: "hi", createDirs: false },
  });

  const nested = await callAndCapture(() =>
    filesystem.writeText("/deep/a.txt", "hi", { createDirs: true }),
  );
  assert.equal(nested.request.params.createDirs, true);

  const removal = await callAndCapture(() => filesystem.remove("/dir", { recursive: true }));
  assert.deepEqual(removal.request.params, { path: "/dir", recursive: true });
});

test("openFile and openFiles differ only by the multiple flag", async () => {
  const one = await callAndCapture(() => dialog.openFile({ title: "Pick" }));
  assert.equal(one.request.method, "dialog.openFile");
  assert.deepEqual(one.request.params, { title: "Pick", multiple: false });

  const many = await callAndCapture(() => dialog.openFiles(), () => ({ result: [] }));
  assert.equal(many.request.params.multiple, true);
});

test("a cancelled picker resolves to null rather than throwing", async () => {
  const { value } = await callAndCapture(() => dialog.openFile(), () => ({ result: null }));
  assert.equal(value, null);
});

test("window sizes are sent as named numbers", async () => {
  const { request } = await callAndCapture(() => appWindow.setSize(800, 600));
  assert.deepEqual(request.params, { width: 800, height: 600 });

  const flag = await callAndCapture(() => appWindow.setFullscreen(true));
  assert.deepEqual(flag.request.params, { value: true });
});

test("notification.show accepts a bare string", async () => {
  const { request } = await callAndCapture(() => notification.show("Done"));
  assert.deepEqual(request.params, { title: "", body: "Done" });

  const full = await callAndCapture(() => notification.show({ title: "Hi", body: "There" }));
  assert.deepEqual(full.request.params, { title: "Hi", body: "There" });
});

test("static app facts need no round trip", () => {
  posted.length = 0;
  assert.deepEqual(app.infoSync(), {
    name: "Test App",
    version: "1.2.3",
    identifier: "dev.vantail.test",
    isDev: true,
  });
  assert.deepEqual(os.infoSync(), { platform: "macos", arch: "arm64" });
  assert.equal(posted.length, 0);
});

test("events reach listeners until they unsubscribe", () => {
  const seen = [];
  const stop = listen("window.resized", (payload) => seen.push(payload));

  dispatch({ event: "window.resized", payload: { width: 100, height: 50 } });
  dispatch({ event: "window.moved", payload: { x: 1, y: 2 } });
  assert.deepEqual(seen, [{ width: 100, height: 50 }]);

  stop();
  dispatch({ event: "window.resized", payload: { width: 200, height: 60 } });
  assert.equal(seen.length, 1);
});

test("one listener throwing does not stop the others", () => {
  const seen = [];
  const stopFirst = listen("window.focus", () => {
    throw new Error("bad listener");
  });
  const stopSecond = listen("window.focus", (payload) => seen.push(payload));

  dispatch({ event: "window.focus", payload: { focused: true } });
  assert.deepEqual(seen, [{ focused: true }]);

  stopFirst();
  stopSecond();
});

test("a response for an unknown id is ignored rather than throwing", () => {
  assert.doesNotThrow(() => dispatch({ id: "not-a-real-call", result: 1 }));
});

// ---------------------------------------------------------------------------
// Multiple windows
// ---------------------------------------------------------------------------

test("appWindow names no window, so the runtime answers for the caller", async () => {
  const { request } = await callAndCapture(() => appWindow.setTitle("Hello"));
  assert.deepEqual(request.params, { title: "Hello" });
  assert.equal(currentWindow(), "main");
});

test("a handle to another window puts its label on every call", async () => {
  const settings = getWindow("settings");
  assert.equal(settings.label, "settings");

  const { request } = await callAndCapture(() => settings.setSize(400, 300));
  assert.deepEqual(request.params, { label: "settings", width: 400, height: 300 });
});

test("createWindow separates the url from the window options", async () => {
  const { request, value } = await callAndCapture(
    () => createWindow("preview", { url: "/preview.html", width: 500, alwaysOnTop: true }),
    (message) => {
      // A window exists before its page does, so createWindow waits for the
      // runtime to say the document has loaded.
      queueMicrotask(() => dispatch({ event: "window.ready", payload: { label: "preview" } }));
      return { result: message.params.label };
    },
  );

  assert.equal(request.method, "window.create");
  assert.deepEqual(request.params, {
    label: "preview",
    url: "/preview.html",
    window: { width: 500, alwaysOnTop: true },
  });
  assert.equal(value.label, "preview");
});

test("createWindow can skip the wait", async () => {
  // No window.ready is ever dispatched here; without the opt-out this would
  // sit until the timeout.
  const { value } = await callAndCapture(
    () => createWindow("fast", { waitForReady: false }),
    () => ({ result: "fast" }),
  );
  assert.equal(value.label, "fast");
});

test("a window whose page never loads fails with an explanation", async () => {
  respond = () => ({ result: "broken" });
  await assert.rejects(
    createWindow("broken", { readyTimeoutMs: 40 }),
    /did not finish loading/,
  );
});

test("listWindows asks for labels", async () => {
  const { request, value } = await callAndCapture(listWindows, () => ({
    result: ["main", "settings"],
  }));
  assert.equal(request.method, "window.list");
  assert.deepEqual(value, ["main", "settings"]);
});

test("a window handle only hears about its own window", () => {
  const seen = [];
  const stopMain = appWindow.onResized((size) => seen.push(["main", size.width]));
  const stopOther = getWindow("settings").onResized((size) => seen.push(["settings", size.width]));

  dispatch({ event: "window.resized", payload: { width: 10, height: 10, label: "main" } });
  dispatch({ event: "window.resized", payload: { width: 20, height: 20, label: "settings" } });

  // Each handle hears only about the window it stands for - `appWindow`
  // included, which resolves to the label the runtime injected.
  assert.deepEqual(seen, [["main", 10], ["settings", 20]]);

  stopMain();
  stopOther();
});

// ---------------------------------------------------------------------------
// Cross-window messages
// ---------------------------------------------------------------------------

test("app.emit and app.listen agree on the wire format", async () => {
  const { request } = await callAndCapture(() =>
    app.emit("saved", { path: "/a.txt" }, { to: "preview" }),
  );
  assert.equal(request.method, "app.emit");
  assert.deepEqual(request.params, {
    event: "saved",
    payload: { path: "/a.txt" },
    to: "preview",
  });

  const seen = [];
  const stop = app.listen("saved", (payload, meta) => seen.push([payload, meta]));
  // User events are namespaced so they cannot collide with window.resized.
  dispatch({ event: "user:saved", payload: { from: "main", payload: { path: "/a.txt" } } });
  assert.deepEqual(seen, [[{ path: "/a.txt" }, { from: "main" }]]);
  stop();
});

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

test("menu items get the type the runtime insists on, all the way down", async () => {
  const { request } = await callAndCapture(() =>
    menu.set([
      { id: "new", label: "New" },
      { type: "separator" },
      {
        type: "submenu",
        label: "Edit",
        items: [{ id: "copy", label: "Copy" }, { type: "predefined", item: "paste" }],
      },
    ]),
  );

  assert.deepEqual(request.params.items, [
    { type: "normal", id: "new", label: "New" },
    { type: "separator" },
    {
      type: "submenu",
      label: "Edit",
      items: [
        { type: "normal", id: "copy", label: "Copy" },
        { type: "predefined", item: "paste" },
      ],
    },
  ]);
});

test("menu clicks carry the id that was set", () => {
  const seen = [];
  const stop = menu.onClick(({ id }) => seen.push(id));
  dispatch({ event: "menu.click", payload: { id: "new" } });
  assert.deepEqual(seen, ["new"]);
  stop();
});

test("tray menus are normalized the same way", async () => {
  const { request } = await callAndCapture(() =>
    tray.set({ icon: "icon.png", menu: [{ id: "open", label: "Open" }] }),
  );
  assert.deepEqual(request.params.menu, [{ type: "normal", id: "open", label: "Open" }]);
  assert.equal(request.params.icon, "icon.png");
});

// ---------------------------------------------------------------------------
// Binary files
// ---------------------------------------------------------------------------

test("bytes survive the base64 round trip", async () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255, 0x89, 0x50, 0x4e, 0x47]);

  const write = await callAndCapture(() => filesystem.writeBinary("/a.png", bytes));
  assert.equal(write.request.method, "filesystem.writeBinary");
  const encoded = write.request.params.data;

  const read = await callAndCapture(() => filesystem.readBinary("/a.png"), () => ({
    result: encoded,
  }));
  assert.deepEqual([...read.value], [...bytes]);
});

test("an ArrayBuffer or a view is accepted as well as a Uint8Array", async () => {
  const buffer = new Uint8Array([1, 2, 3, 4]).buffer;

  const fromBuffer = await callAndCapture(() => filesystem.writeBinary("/a", buffer));
  const fromView = await callAndCapture(() =>
    filesystem.writeBinary("/a", new Uint8Array(buffer, 1, 2)),
  );

  assert.equal(fromBuffer.request.params.data, "AQIDBA==");
  assert.equal(fromView.request.params.data, "AgM=");
});

test("an empty file is not a special case", async () => {
  const write = await callAndCapture(() => filesystem.writeBinary("/e", new Uint8Array()));
  assert.equal(write.request.params.data, "");

  const read = await callAndCapture(() => filesystem.readBinary("/e"), () => ({ result: "" }));
  assert.equal(read.value.length, 0);
});

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

test("execute passes the program and arguments as a vector", async () => {
  const { request } = await callAndCapture(
    () => childProcess.execute("git", ["status", "--porcelain"], { cwd: "/repo" }),
    () => ({ result: { code: 0, stdout: "", stderr: "", success: true, signal: null } }),
  );

  assert.equal(request.method, "process.execute");
  assert.deepEqual(request.params, {
    program: "git",
    args: ["status", "--porcelain"],
    cwd: "/repo",
  });
});

test("a spawned child only hears its own output", async () => {
  const { value: child } = await callAndCapture(
    () => childProcess.spawn("cat"),
    () => ({ result: { id: 7, pid: 4242 } }),
  );
  assert.equal(child.id, 7);
  assert.equal(child.pid, 4242);

  const out = [];
  const exits = [];
  const stopOut = child.onStdout((data) => out.push(data));
  const stopExit = child.onExit((event) => exits.push(event.code));

  dispatch({ event: "process.stdout", payload: { id: 7, data: "mine" } });
  dispatch({ event: "process.stdout", payload: { id: 8, data: "somebody else's" } });
  dispatch({ event: "process.exit", payload: { id: 7, code: 0, signal: null, success: true } });

  assert.deepEqual(out, ["mine"]);
  assert.deepEqual(exits, [0]);

  stopOut();
  stopExit();

  const write = await callAndCapture(() => child.write("hello"));
  assert.deepEqual(write.request.params, { id: 7, data: "hello" });
});

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

test("download reports progress and stops listening when it finishes", async () => {
  const progress = [];

  respond = () => {
    // Progress arrives while the call is in flight.
    dispatch({ event: "updater.progress", payload: { downloaded: 50, total: 100 } });
    return { result: { ready: true, version: "1.1.0", bytes: 100 } };
  };

  const result = await updater.download((event) => progress.push(event.downloaded));
  assert.deepEqual(result, { ready: true, version: "1.1.0", bytes: 100 });
  assert.deepEqual(progress, [50]);

  // Unsubscribed afterwards, so a later download does not double-report.
  dispatch({ event: "updater.progress", payload: { downloaded: 99, total: 100 } });
  assert.deepEqual(progress, [50]);
});

test("shell.open sends the target verbatim", async () => {
  const { request } = await callAndCapture(() => shell.open("https://example.com"));
  assert.deepEqual(request.params, { target: "https://example.com" });
});

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

test("a request carries the method, headers and body the device will see", async () => {
  const { request } = await callAndCapture(
    () =>
      network.request({
        url: "http://192.168.1.7/api",
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: '{"on":true}',
        timeoutMs: 5000,
      }),
    () => ({ result: { url: "", status: 200, statusText: "OK", ok: true, headers: {}, body: "", encoding: "text" } }),
  );

  assert.equal(request.method, "network.request");
  assert.deepEqual(request.params, {
    url: "http://192.168.1.7/api",
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: '{"on":true}',
    timeoutMs: 5000,
    responseType: "text",
  });
});

test("bytes are sent as base64 and win over a text body", async () => {
  const { request } = await callAndCapture(
    () => network.request({ url: "http://d/", bytes: new Uint8Array([1, 2, 3]), body: "ignored" }),
    () => ({ result: { url: "", status: 200, statusText: "", ok: true, headers: {}, body: "", encoding: "text" } }),
  );

  assert.equal(request.params.bodyBase64, "AQID");
  assert.equal(request.params.body, undefined);
});

test("json parses the body, and says so clearly when it cannot", async () => {
  const { value } = await callAndCapture(
    () => network.json({ url: "http://d/" }),
    () => ({
      result: { url: "http://d/", status: 200, statusText: "OK", ok: true, headers: {}, body: '{"on":true}', encoding: "text" },
    }),
  );
  assert.deepEqual(value.body, { on: true });

  respond = () => ({
    result: { url: "http://d/", status: 500, statusText: "", ok: false, headers: {}, body: "<html>oops", encoding: "text" },
  });
  await assert.rejects(network.json({ url: "http://d/" }), /did not return JSON \(500\)/);
});

test("a binary response comes back as bytes", async () => {
  const { request, value } = await callAndCapture(
    () => network.binary({ url: "http://d/icon.png" }),
    () => ({
      result: { url: "", status: 200, statusText: "", ok: true, headers: {}, body: "iVBORw==", encoding: "base64" },
    }),
  );

  assert.equal(request.params.responseType, "base64");
  assert.deepEqual([...value.body.slice(0, 4)], [137, 80, 78, 71]);
});

// ---------------------------------------------------------------------------
// Surviving a close
// ---------------------------------------------------------------------------

test("close behavior is set per window", async () => {
  const own = await callAndCapture(() => appWindow.setCloseBehavior("hide"));
  assert.deepEqual(own.request.params, { behavior: "hide" });

  const other = await callAndCapture(() => getWindow("settings").setCloseBehavior("ask"));
  assert.deepEqual(other.request.params, { label: "settings", behavior: "ask" });
});

test("a close request reports what the runtime did about it", () => {
  const seen = [];
  const stop = appWindow.onCloseRequested((event) => seen.push(event.outcome));
  dispatch({ event: "window.closeRequested", payload: { label: "main", outcome: "hidden" } });
  assert.deepEqual(seen, ["hidden"]);
  stop();
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test("a missing secret is null rather than a rejection", async () => {
  const { request, value } = await callAndCapture(
    () => secrets.get("service.refreshToken"),
    () => ({ result: null }),
  );
  assert.equal(request.method, "secrets.get");
  assert.deepEqual(request.params, { key: "service.refreshToken" });
  assert.equal(value, null);
});

test("delete says whether there was anything to delete", async () => {
  const { value } = await callAndCapture(() => secrets.delete("gone"), () => ({ result: false }));
  assert.equal(value, false);
});

// ---------------------------------------------------------------------------
// Service discovery
// ---------------------------------------------------------------------------

test("discover passes the service type and timeout through", async () => {
  const { request } = await callAndCapture(
    () => mdns.discover({ service: "_hub._tcp.local", timeoutMs: 5000 }),
    () => ({ result: [] }),
  );
  assert.equal(request.method, "mdns.discover");
  assert.deepEqual(request.params, { service: "_hub._tcp.local", timeoutMs: 5000 });
});

test("browse events reach their listeners", () => {
  const found = [];
  const lost = [];
  const stopFound = mdns.onFound((service) => found.push(service.name));
  const stopLost = mdns.onLost((service) => lost.push(service.name));

  dispatch({ event: "mdns.found", payload: { name: "Living Room Hub", addresses: ["192.168.1.7"] } });
  dispatch({ event: "mdns.lost", payload: { name: "Living Room Hub" } });

  assert.deepEqual(found, ["Living Room Hub"]);
  assert.deepEqual(lost, ["Living Room Hub"]);
  stopFound();
  stopLost();
});

// ---------------------------------------------------------------------------
// HID
// ---------------------------------------------------------------------------

test("an open device gives a handle-scoped connection", async () => {
  const { value: connection } = await callAndCapture(
    () => hid.open("DevSrvsID:1"),
    () => ({ result: { handle: 3, vendorId: 0x0fd9, productId: 0x0080 } }),
  );

  assert.equal(connection.handle, 3);
  assert.equal(connection.vendorId, 0x0fd9);

  // The first byte is the report id, and it travels as base64.
  const written = await callAndCapture(
    () => connection.write(new Uint8Array([0x02, 0x0b, 0x01])),
    () => ({ result: 3 }),
  );
  assert.deepEqual(written.request.params, { handle: 3, data: "AgsB" });

  const feature = await callAndCapture(
    () => connection.getFeatureReport(0x05, 4),
    () => ({ result: "BQECAw==" }),
  );
  assert.deepEqual(feature.request.params, { handle: 3, reportId: 5, length: 4 });
  assert.deepEqual([...feature.value], [5, 1, 2, 3]);
});

test("input reports reach only the connection they belong to", async () => {
  const { value: connection } = await callAndCapture(
    () => hid.open("DevSrvsID:1"),
    () => ({ result: { handle: 9, vendorId: 1, productId: 2 } }),
  );

  const seen = [];
  const closed = [];
  const stopInput = connection.onInput((data) => seen.push([...data]));
  const stopClosed = connection.onClosed((event) => closed.push(event.reason));

  dispatch({ event: "hid.input", payload: { handle: 9, data: "AQI=" } });
  dispatch({ event: "hid.input", payload: { handle: 10, data: "//8=" } });
  dispatch({ event: "hid.closed", payload: { handle: 9, reason: "disconnected" } });

  assert.deepEqual(seen, [[1, 2]]);
  assert.deepEqual(closed, ["disconnected"]);
  stopInput();
  stopClosed();
});

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

test("a link that arrived before the handler still reaches it", async () => {
  // The cold-start case: the application was launched *by* the link, so the
  // runtime held it until somebody asked.
  resetDeepLinkState();
  respond = (message) =>
    message.method === "deeplink.subscribe"
      ? { result: ["myapp://callback?code=abc"] }
      : { result: null };

  const seen = [];
  const stop = deepLink.onOpen((url) => seen.push(url));

  // Delivered on a later tick, since it comes back from a call.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, ["myapp://callback?code=abc"]);
  stop();
});

test("a second handler sees the launch link too", async () => {
  resetDeepLinkState();
  let subscribes = 0;
  respond = (message) => {
    if (message.method === "deeplink.subscribe") {
      subscribes += 1;
      return { result: ["myapp://launch"] };
    }
    return { result: null };
  };

  const first = [];
  const second = [];
  const stopFirst = deepLink.onOpen((url) => first.push(url));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stopSecond = deepLink.onOpen((url) => second.push(url));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Draining is a one-shot on the runtime side, so the SDK remembers what it
  // got rather than letting whoever subscribed first keep it.
  assert.equal(subscribes, 1);
  assert.deepEqual(first, ["myapp://launch"]);
  assert.deepEqual(second, ["myapp://launch"]);

  stopFirst();
  stopSecond();
});

test("links that arrive later come through as events", async () => {
  resetDeepLinkState();
  respond = () => ({ result: [] });

  const seen = [];
  const stop = deepLink.onOpen((url) => seen.push(url));
  await new Promise((resolve) => setTimeout(resolve, 0));

  dispatch({ event: "deeplink.open", payload: { url: "myapp://later" } });
  assert.deepEqual(seen, ["myapp://later"]);

  stop();
  dispatch({ event: "deeplink.open", payload: { url: "myapp://after-unsubscribe" } });
  assert.deepEqual(seen, ["myapp://later"]);
});

test("a second launch reports what it was asked to do", () => {
  const seen = [];
  const stop = app.onSecondInstance((launch) => seen.push(launch));
  dispatch({
    event: "app.secondInstance",
    payload: { args: ["vantail", "myapp://x"], cwd: "/home/me" },
  });
  assert.deepEqual(seen, [{ args: ["vantail", "myapp://x"], cwd: "/home/me" }]);
  stop();
});
