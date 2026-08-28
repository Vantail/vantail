/**
 * `network`, against a fake bridge.
 *
 * The parts worth pinning down here are the ones an application cannot check
 * for itself: that a repeated header survives the trip intact, and that
 * aborting actually names the request it is abandoning.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const posted = [];
const listeners = new Set();
/** Set per test: return a response to answer immediately, or null to hang. */
let auto = () => null;

function deliver(message) {
  for (const listener of [...listeners]) listener(message);
}

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
    const reply = auto(message);
    if (reply) queueMicrotask(() => deliver({ id: message.id, ...reply }));
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const { network, VantailError } = await import("../dist/index.js");

/** A complete response, as the runtime renders one. */
function answer(overrides = {}) {
  return {
    result: {
      url: "https://api.example.com/v1",
      status: 200,
      statusText: "OK",
      ok: true,
      headers: {},
      headerPairs: [],
      body: "",
      encoding: "text",
      bodyBytes: 0,
      redirects: [],
      timing: { ttfbMs: 1, headMs: 1, downloadMs: 0, totalMs: 1 },
      ...overrides,
    },
  };
}

test("a request carries the url, method and response type", async () => {
  posted.length = 0;
  auto = () => answer({ body: "hi", bodyBytes: 2 });

  const response = await network.request({
    url: "https://api.example.com/v1",
    method: "POST",
    body: "{}",
  });

  assert.equal(posted.at(-1).method, "network.request");
  assert.equal(posted.at(-1).params.url, "https://api.example.com/v1");
  assert.equal(posted.at(-1).params.responseType, "text");
  assert.equal(response.body, "hi");
  assert.equal(response.bodyBytes, 2);
});

test("repeated headers survive as pairs, not as a joined string", async () => {
  // The case that made this necessary: two Set-Cookie headers, one of which
  // has a comma and a space inside its own Expires date. Joining them the
  // way `headers` does cannot be undone.
  const first = "session=abc; Expires=Wed, 09 Jun 2027 10:18:14 GMT";
  const second = "theme=dark; Path=/";

  posted.length = 0;
  auto = () =>
    answer({
      headers: { "set-cookie": `${first}, ${second}` },
      headerPairs: [
        ["set-cookie", first],
        ["set-cookie", second],
      ],
    });

  const response = await network.request({ url: "https://api.example.com/v1" });

  const cookies = response.headerPairs
    .filter(([name]) => name === "set-cookie")
    .map(([, value]) => value);

  assert.deepEqual(cookies, [first, second]);
  // Splitting the record on ", " would have produced three cookies from two.
  assert.equal(response.headers["set-cookie"].split(", ").length, 3);
});

test("the redirect chain and its dropped credentials come back", async () => {
  posted.length = 0;
  auto = () =>
    answer({
      url: "https://cdn.example.net/final",
      redirects: [
        {
          status: 302,
          url: "https://api.example.com/v1",
          location: "https://cdn.example.net/final",
          droppedHeaders: ["authorization"],
        },
      ],
    });

  const response = await network.request({ url: "https://api.example.com/v1" });

  assert.equal(response.redirects.length, 1);
  assert.equal(response.redirects[0].status, 302);
  // The answer to "which hop ate my auth header".
  assert.deepEqual(response.redirects[0].droppedHeaders, ["authorization"]);
});

test("a signal that is already aborted never reaches the runtime", async () => {
  posted.length = 0;
  auto = () => answer();

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    network.request({ url: "https://api.example.com/v1", signal: controller.signal }),
    (error) => VantailError.is(error, "CANCELLED"),
  );
  assert.equal(posted.length, 0, "nothing should have been sent");
});

test("aborting cancels the request by the id it was sent with", async () => {
  posted.length = 0;
  // Hang: the runtime is "still working" until the test says otherwise.
  auto = (message) => (message.method === "network.cancel" ? { result: true } : null);

  const controller = new AbortController();
  const pending = network.request({
    url: "https://api.example.com/slow",
    signal: controller.signal,
  });

  const sent = posted.at(-1);
  controller.abort();
  await Promise.resolve();

  const cancel = posted.at(-1);
  assert.equal(cancel.method, "network.cancel");
  assert.equal(cancel.params.id, sent.id, "cancel must name the request");

  // The runtime is what rejects the original call.
  deliver({
    id: sent.id,
    error: { code: "CANCELLED", message: "The request was cancelled" },
  });
  await assert.rejects(pending, (error) => VantailError.is(error, "CANCELLED"));
});

test("a request without a signal never sends a cancel", async () => {
  posted.length = 0;
  auto = () => answer();

  await network.request({ url: "https://api.example.com/v1" });

  assert.equal(posted.filter((m) => m.method === "network.cancel").length, 0);
});

test("a finished request does not cancel when its signal aborts later", async () => {
  posted.length = 0;
  auto = () => answer();

  const controller = new AbortController();
  await network.request({
    url: "https://api.example.com/v1",
    signal: controller.signal,
  });

  // The listener is removed once the call settles, so an application that
  // reuses a controller does not fire a cancel at a request that is done.
  controller.abort();
  await Promise.resolve();
  assert.equal(posted.filter((m) => m.method === "network.cancel").length, 0);
});

test("binary asks for base64 and decodes it", async () => {
  posted.length = 0;
  auto = () =>
    answer({ body: "AAECAw==", encoding: "base64", bodyBytes: 4 });

  const response = await network.binary({ url: "https://api.example.com/blob" });

  assert.equal(posted.at(-1).params.responseType, "base64");
  assert.deepEqual([...response.body], [0, 1, 2, 3]);
  // Exact, where a text body's `length` would have counted code units.
  assert.equal(response.bodyBytes, 4);
});

/** The head a `network.stream` call answers with. */
function streamHead(id = 1, overrides = {}) {
  return {
    result: {
      id,
      url: "https://api.example.com/events",
      status: 200,
      statusText: "OK",
      ok: true,
      headers: { "content-type": "text/event-stream" },
      headerPairs: [["content-type", "text/event-stream"]],
      redirects: [],
      timing: { ttfbMs: 5, headMs: 5 },
      ...overrides,
    },
  };
}

test("a stream answers with its head, then delivers chunks", async () => {
  posted.length = 0;
  auto = () => streamHead(7);

  const stream = await network.stream({ url: "https://api.example.com/events" });

  assert.equal(posted.at(-1).method, "network.stream");
  assert.equal(posted.at(-1).params.responseType, "text");
  assert.equal(stream.status, 200);
  assert.equal(stream.headers["content-type"], "text/event-stream");

  const seen = [];
  stream.onChunk((chunk) => seen.push(chunk));

  deliver({ event: "network.chunk", payload: { id: 7, data: "one" } });
  deliver({ event: "network.chunk", payload: { id: 7, data: "two" } });
  // Another stream's chunks are not this stream's.
  deliver({ event: "network.chunk", payload: { id: 8, data: "elsewhere" } });

  assert.deepEqual(seen, ["one", "two"]);
});

test("chunks that arrive before anyone listens are not lost", async () => {
  posted.length = 0;
  auto = () => streamHead(11);

  const stream = await network.stream({ url: "https://api.example.com/events" });

  // The application awaited something before subscribing.
  deliver({ event: "network.chunk", payload: { id: 11, data: "first" } });
  deliver({ event: "network.chunk", payload: { id: 11, data: "second" } });

  const seen = [];
  stream.onChunk((chunk) => seen.push(chunk));
  assert.deepEqual(seen, ["first", "second"]);

  // And it keeps up from there.
  deliver({ event: "network.chunk", payload: { id: 11, data: "third" } });
  assert.deepEqual(seen, ["first", "second", "third"]);
});

test("the end event fires once, and afterwards on attach", async () => {
  posted.length = 0;
  auto = () => streamHead(12);

  const stream = await network.stream({ url: "https://api.example.com/events" });

  const ends = [];
  stream.onEnd((end) => ends.push(end));
  deliver({
    event: "network.end",
    payload: { id: 12, cancelled: false, error: null },
  });

  assert.deepEqual(ends, [{ cancelled: false }]);

  // A handler attached after the fact still hears what happened, rather than
  // waiting for an event that has been and gone.
  const late = [];
  stream.onEnd((end) => late.push(end));
  assert.deepEqual(late, [{ cancelled: false }]);
});

test("a stream that fails part-way reports why", async () => {
  posted.length = 0;
  auto = () => streamHead(13);

  const stream = await network.stream({ url: "https://api.example.com/events" });
  const ends = [];
  stream.onEnd((end) => ends.push(end));

  deliver({
    event: "network.end",
    payload: { id: 13, cancelled: false, error: "connection reset" },
  });

  assert.equal(ends[0].error, "connection reset");
  assert.equal(ends[0].cancelled, false);
});

test("cancelling a stream names the stream, not the request", async () => {
  posted.length = 0;
  auto = (message) =>
    message.method === "network.stream"
      ? streamHead(21)
      : { result: true };

  const stream = await network.stream({ url: "https://api.example.com/events" });
  assert.equal(await stream.cancel(), true);

  assert.equal(posted.at(-1).method, "network.cancelStream");
  assert.equal(posted.at(-1).params.id, 21);
});

test("a signal cancels the head before it arrives, and the stream after", async () => {
  posted.length = 0;
  // Hang on the head so the abort lands in the first phase.
  auto = (message) => (message.method === "network.stream" ? null : { result: true });

  const controller = new AbortController();
  const pending = network.stream({
    url: "https://api.example.com/slow",
    signal: controller.signal,
  });

  const sent = posted.at(-1);
  controller.abort();
  await Promise.resolve();

  // Before the head, the request id is what gets abandoned.
  assert.equal(posted.at(-1).method, "network.cancel");
  assert.equal(posted.at(-1).params.id, sent.id);

  deliver({
    id: sent.id,
    error: { code: "CANCELLED", message: "The request was cancelled" },
  });
  await assert.rejects(pending, (error) => VantailError.is(error, "CANCELLED"));
});

test("a signal that aborts after the head cancels the stream", async () => {
  posted.length = 0;
  auto = (message) =>
    message.method === "network.stream" ? streamHead(31) : { result: true };

  const controller = new AbortController();
  const stream = await network.stream({
    url: "https://api.example.com/events",
    signal: controller.signal,
  });
  assert.equal(stream.id, 31);

  controller.abort();
  await Promise.resolve();

  assert.equal(posted.at(-1).method, "network.cancelStream");
  assert.equal(posted.at(-1).params.id, 31);
});

test("streamBinary asks for base64 and decodes each chunk", async () => {
  posted.length = 0;
  auto = () => streamHead(41);

  const stream = await network.streamBinary({ url: "https://api.example.com/blob" });
  assert.equal(posted.at(-1).params.responseType, "base64");

  const seen = [];
  stream.onChunk((chunk) => seen.push([...chunk]));
  deliver({ event: "network.chunk", payload: { id: 41, data: "AAECAw==" } });

  assert.deepEqual(seen, [[0, 1, 2, 3]]);
});

/** The answer a `network.socket` call gets once the handshake is done. */
function socketOpened(id = 1, protocol = null) {
  return {
    result: { id, url: "wss://api.example.com/live", protocol },
  };
}

test("a socket sends its headers on the handshake", async () => {
  posted.length = 0;
  auto = () => socketOpened(5, "graphql-transport-ws");

  const socket = await network.socket({
    url: "wss://api.example.com/live",
    headers: { authorization: "Bearer t" },
    protocols: ["graphql-transport-ws"],
  });

  // The whole reason this exists rather than the webview's own WebSocket.
  assert.equal(posted.at(-1).method, "network.socket");
  assert.equal(posted.at(-1).params.headers.authorization, "Bearer t");
  assert.deepEqual(posted.at(-1).params.protocols, ["graphql-transport-ws"]);
  assert.equal(socket.protocol, "graphql-transport-ws");
  assert.equal(socket.id, 5);
});

test("text and binary messages arrive as their own types", async () => {
  posted.length = 0;
  auto = () => socketOpened(6);

  const socket = await network.socket({ url: "wss://api.example.com/live" });
  const seen = [];
  socket.onMessage((data) => seen.push(data));

  deliver({
    event: "network.message",
    payload: { id: 6, data: "hello", binary: false },
  });
  deliver({
    event: "network.message",
    payload: { id: 6, data: "AAECAw==", binary: true },
  });
  // Another socket's traffic is not this socket's.
  deliver({
    event: "network.message",
    payload: { id: 99, data: "elsewhere", binary: false },
  });

  assert.equal(seen[0], "hello");
  assert.deepEqual([...seen[1]], [0, 1, 2, 3]);
  assert.equal(seen.length, 2);
});

test("messages that arrive before anyone listens are not lost", async () => {
  posted.length = 0;
  auto = () => socketOpened(14);

  const socket = await network.socket({ url: "wss://api.example.com/live" });
  deliver({
    event: "network.message",
    payload: { id: 14, data: "early", binary: false },
  });

  const seen = [];
  socket.onMessage((data) => seen.push(data));
  assert.deepEqual(seen, ["early"]);
});

test("sending text and bytes take different shapes on the wire", async () => {
  posted.length = 0;
  auto = (message) =>
    message.method === "network.socket" ? socketOpened(8) : { result: null };

  const socket = await network.socket({ url: "wss://api.example.com/live" });

  await socket.send("ping");
  assert.equal(posted.at(-1).method, "network.socketSend");
  assert.equal(posted.at(-1).params.data, "ping");
  assert.notEqual(posted.at(-1).params.binary, true);

  await socket.sendBytes(new Uint8Array([0, 1, 2, 3]));
  assert.equal(posted.at(-1).params.binary, true);
  assert.equal(posted.at(-1).params.data, "AAECAw==");
});

test("closing reports the code and reason, once", async () => {
  posted.length = 0;
  auto = (message) =>
    message.method === "network.socket" ? socketOpened(9) : { result: null };

  const socket = await network.socket({ url: "wss://api.example.com/live" });
  const closes = [];
  socket.onClose((closed) => closes.push(closed));

  await socket.close(1000, "done");
  assert.equal(posted.at(-1).method, "network.socketClose");
  assert.equal(posted.at(-1).params.code, 1000);

  deliver({
    event: "network.socketClosed",
    payload: { id: 9, code: 1000, reason: "done", error: null, cancelled: true },
  });

  assert.deepEqual(closes, [{ code: 1000, reason: "done", cancelled: true }]);

  // A handler attached afterwards still hears what happened.
  const late = [];
  socket.onClose((closed) => late.push(closed));
  assert.equal(late.length, 1);
});

test("a socket that drops reports the failure rather than a clean close", async () => {
  posted.length = 0;
  auto = () => socketOpened(10);

  const socket = await network.socket({ url: "wss://api.example.com/live" });
  const closes = [];
  socket.onClose((closed) => closes.push(closed));

  deliver({
    event: "network.socketClosed",
    payload: {
      id: 10,
      code: null,
      reason: "",
      error: "connection reset",
      cancelled: false,
    },
  });

  assert.equal(closes[0].error, "connection reset");
  assert.equal(closes[0].code, undefined);
  assert.equal(closes[0].cancelled, false);
});

test("a signal abandons the handshake, and closes the socket after it", async () => {
  posted.length = 0;
  auto = (message) => (message.method === "network.socket" ? null : { result: true });

  const controller = new AbortController();
  const opening = network.socket({
    url: "wss://api.example.com/slow",
    signal: controller.signal,
  });

  const sent = posted.at(-1);
  controller.abort();
  await Promise.resolve();

  assert.equal(posted.at(-1).method, "network.cancel");
  assert.equal(posted.at(-1).params.id, sent.id);

  deliver({
    id: sent.id,
    error: { code: "CANCELLED", message: "The request was cancelled" },
  });
  await assert.rejects(opening, (error) => VantailError.is(error, "CANCELLED"));

  // And once it is up, the same signal closes it instead.
  posted.length = 0;
  auto = (message) =>
    message.method === "network.socket" ? socketOpened(15) : { result: null };
  const second = new AbortController();
  await network.socket({
    url: "wss://api.example.com/live",
    signal: second.signal,
  });
  second.abort();
  await Promise.resolve();
  assert.equal(posted.at(-1).method, "network.socketClose");
  assert.equal(posted.at(-1).params.id, 15);
});
