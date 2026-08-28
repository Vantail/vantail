import { decode, encode, type BinaryInput } from "./binary.js";
import { VantailError } from "./error.js";
import { ErrorCode } from "./protocol.js";
import { invoke, invokeTracked, listen } from "./transport.js";

export interface NetworkRequestOptions {
  /** An absolute URL. Checked against `permissions.network` before it is sent. */
  url: string;
  /** Default `GET`. Any method the server understands. */
  method?: string;
  headers?: Record<string, string>;
  /** Sent as UTF-8. Ignored when `bytes` is given. */
  body?: string;
  /** Sent as raw bytes. */
  bytes?: BinaryInput;
  /** Default 30000. */
  timeoutMs?: number;
  /** Default 5. Every hop is permission-checked. */
  maxRedirects?: number;
  /**
   * Abandon the request, the way `fetch` does.
   *
   * Aborting rejects this call at once with a `CANCELLED` `VantailError`. It
   * does not stop the request that is already on the wire: the runtime cannot
   * interrupt a socket read in progress, so the connection is dropped when it
   * next comes up for air or when `timeoutMs` expires. For a stop button that
   * is exactly right - the application is free immediately - but a burst of
   * cancelled requests to a host that never answers will keep the runtime's
   * network queue busy until they time out.
   */
  signal?: AbortSignal;
}

/** Where the time went. Milliseconds, with a fraction. */
export interface NetworkTiming {
  /**
   * The first byte of the final response, measured from the start of the
   * call - so redirects, DNS, connecting and TLS are all inside this number.
   */
  ttfbMs: number;
  /** The final request on its own, up to its response head. */
  headMs: number;
  /** Reading the body, after the head arrived. */
  downloadMs: number;
  /** Everything, including every redirect hop. */
  totalMs: number;
}

/** One hop that was followed on the way to the answer. */
export interface NetworkRedirect {
  /** The 3xx that sent us on. */
  status: number;
  /** The URL that answered with it. */
  url: string;
  /** Its `Location` header, exactly as sent - which may be relative. */
  location: string;
  /**
   * Credentials dropped because this hop crossed to another host, the way a
   * browser drops them. The answer to "which redirect ate my auth header".
   */
  droppedHeaders: string[];
}

export interface NetworkResponse<Body = string> {
  /** The URL that actually answered, after any redirects. */
  url: string;
  status: number;
  statusText: string;
  /** `true` for 2xx. */
  ok: boolean;
  /** Lower-cased names. Repeated headers are joined with `, `. */
  headers: Record<string, string>;
  /**
   * Every header line in the order it arrived, repeats intact.
   *
   * `headers` is the convenient form and right nearly always, but it cannot
   * represent `set-cookie`: that header is legitimately repeated, and joining
   * it is ambiguous because an `Expires` date contains a comma and a space of
   * its own. Read cookies from here instead:
   *
   * ```ts
   * const cookies = response.headerPairs
   *   .filter(([name]) => name === "set-cookie")
   *   .map(([, value]) => value);
   * ```
   */
  headerPairs: [string, string][];
  body: Body;
  /**
   * The size of the body in bytes, after any content decoding - a gzipped
   * response counts as what it inflated to.
   *
   * Worth having even when you have the body: `body.length` on a string
   * counts UTF-16 code units, which is not the byte count for anything
   * outside ASCII.
   */
  bodyBytes: number;
  /** Every redirect followed, in order. Empty when there were none. */
  redirects: NetworkRedirect[];
  timing: NetworkTiming;
}

/** Everything a stream knows before its first byte of body. */
export interface NetworkStreamHead {
  /** The URL that actually answered, after any redirects. */
  url: string;
  status: number;
  statusText: string;
  ok: boolean;
  headers: Record<string, string>;
  /** Every header line in order, repeats intact. */
  headerPairs: [string, string][];
  redirects: NetworkRedirect[];
  /** Only the two that are known before the body has been read. */
  timing: { ttfbMs: number; headMs: number };
}

export interface NetworkStreamEnd {
  /** `true` when it stopped because the application asked it to. */
  cancelled: boolean;
  /** Set when the connection failed part-way through. */
  error?: string;
}

/** A response being delivered as it arrives. */
export interface NetworkStream<Chunk> extends NetworkStreamHead {
  /** The handle the runtime knows this stream by. */
  readonly id: number;

  /**
   * Chunks as they arrive, in order.
   *
   * Chunks that arrive before the first handler is attached are held and
   * delivered to it, so `await`ing something between opening the stream and
   * listening to it does not silently lose the beginning. Attach promptly all
   * the same: nothing is dropped, which means nothing is bounded either.
   */
  onChunk(handler: (chunk: Chunk) => void): () => void;

  /** The stream finished, failed, or was cancelled. Fires exactly once. */
  onEnd(handler: (end: NetworkStreamEnd) => void): () => void;

  /**
   * Stop it. Resolves `false` if it had already finished.
   *
   * As with `signal` on a buffered request, this frees the application at
   * once; the connection itself is dropped when the runtime's reader next
   * comes up for air.
   */
  cancel(): Promise<boolean>;
}

interface RawStreamHead extends NetworkStreamHead {
  id: number;
}

export interface NetworkSocketOptions {
  /** A `ws://` or `wss://` URL. Checked against `permissions.network`. */
  url: string;
  /**
   * Sent on the opening handshake.
   *
   * The reason this exists: the webview's own `WebSocket` takes a URL and a
   * subprotocol list and nothing else, so a bearer token has to go in the
   * query string, where it ends up in server logs.
   */
  headers?: Record<string, string>;
  /** Subprotocols to offer. The server picks at most one. */
  protocols?: string[];
  /** Connecting and the handshake, not the life of the socket. Default 30000. */
  timeoutMs?: number;
  /** Abandons the handshake, or closes the socket once it is up. */
  signal?: AbortSignal;
}

export interface NetworkSocketClosed {
  /** The WebSocket close code, when the other side sent one. */
  code?: number;
  reason: string;
  /** Set when the connection failed rather than closed. */
  error?: string;
  /** `true` when it closed because the application asked. */
  cancelled: boolean;
}

/** An open WebSocket. */
export interface NetworkSocket {
  /** The handle the runtime knows this socket by. */
  readonly id: number;
  readonly url: string;
  /** The subprotocol the server chose, if any. */
  readonly protocol?: string;

  /** Send a text message. */
  send(data: string): Promise<null>;
  /** Send a binary message. */
  sendBytes(data: BinaryInput): Promise<null>;

  /**
   * Messages as they arrive. Text messages give a `string`, binary ones a
   * `Uint8Array`.
   *
   * As with a stream, messages that arrive before the first handler is
   * attached are held and delivered to it.
   */
  onMessage(handler: (data: string | Uint8Array) => void): () => void;

  /** The socket closed, failed, or was closed by this application. */
  onClose(handler: (closed: NetworkSocketClosed) => void): () => void;

  /** Close it, optionally with a code and reason. */
  close(code?: number, reason?: string): Promise<null>;
}

interface RawSocket {
  id: number;
  url: string;
  protocol: string | null;
}

interface RawResponse {
  url: string;
  status: number;
  statusText: string;
  ok: boolean;
  headers: Record<string, string>;
  headerPairs: [string, string][];
  body: string;
  encoding: "text" | "base64";
  bodyBytes: number;
  redirects: NetworkRedirect[];
  timing: NetworkTiming;
}

/**
 * HTTP from the runtime rather than the webview.
 *
 * Use the ordinary `fetch` for the internet - it works, it streams, and it is
 * the thing you already know. Reach for this when `fetch` cannot do the job,
 * which on a desktop app means talking to hardware on the user's own network:
 *
 * - a smart-home hub serves HTTPS with a self-signed certificate, which
 *   `fetch` refuses outright;
 * - a smart light, a desk display or a single-board computer sends no CORS
 *   headers, so `fetch` makes the request and then refuses to let you read
 *   the answer.
 *
 * Neither is something an application can work around, which is exactly what
 * makes this a platform capability rather than a convenience.
 *
 * ```ts
 * const { body } = await network.request({
 *   url: `http://${light.host}:9123/api/lights`,
 *   method: "PUT",
 *   headers: { "content-type": "application/json" },
 *   body: JSON.stringify({ lights: [{ on: 1, brightness: 80 }] }),
 * });
 * ```
 *
 * Every URL is checked against `permissions.network.allow` first, redirects
 * included. An application that has to reach a host its user names at run
 * time - an API client, a link checker - says so with `allow: ["*"]`.
 */
export const network = {
  /**
   * Send a request and read the response as text.
   *
   * The body is decoded as UTF-8, and anything that is not valid UTF-8 is
   * replaced with U+FFFD rather than failing. Use {@link network.binary} when
   * the response might not be text, or when you need the bytes exactly;
   * `bodyBytes` is there to tell you when the two disagree.
   */
  request: async (
    options: NetworkRequestOptions,
  ): Promise<NetworkResponse<string>> => {
    const response = await send(options, "text");
    return { ...response, body: response.body };
  },

  /** The same, parsed as JSON. Throws if the body is not JSON. */
  json: async <T = unknown>(
    options: NetworkRequestOptions,
  ): Promise<NetworkResponse<T>> => {
    const response = await send(options, "text");
    try {
      return { ...response, body: JSON.parse(response.body) as T };
    } catch (cause) {
      throw new SyntaxError(
        `${response.url} did not return JSON (${response.status}): ${String(cause)}`,
      );
    }
  },

  /**
   * The same, with the body as bytes.
   *
   * The better default for anything that is not certainly UTF-8 text: the
   * byte count is exact and nothing is replaced on the way through.
   */
  binary: async (
    options: NetworkRequestOptions,
  ): Promise<NetworkResponse<Uint8Array>> => {
    const response = await send(options, "base64");
    return { ...response, body: decode(response.body) };
  },

  /**
   * A response delivered as it arrives, as text.
   *
   * This is how server-sent events and long-polling are consumed from the
   * runtime at all: `network.request` waits for the whole body, which for a
   * stream that stays open is forever. The webview's own `EventSource` works
   * and is the right tool when CORS allows it - this is for when it does not,
   * and for when the request needs headers `EventSource` cannot set.
   *
   * ```ts
   * const stream = await network.stream({
   *   url: `${base}/events`,
   *   headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
   * });
   *
   * let buffer = "";
   * stream.onChunk((chunk) => {
   *   buffer += chunk;
   *   // SSE separates events with a blank line.
   *   const events = buffer.split("\n\n");
   *   buffer = events.pop() ?? "";
   *   for (const event of events) handle(event);
   * });
   * stream.onEnd(({ error }) => { if (error) retry(); });
   * ```
   *
   * Chunks are decoded as UTF-8 with any character split across a chunk
   * boundary held back and joined to the next one, so a stream of JSON stays
   * parseable.
   */
  stream: (options: NetworkRequestOptions): Promise<NetworkStream<string>> =>
    open(options, "text", (data) => data),

  /**
   * The same, as bytes - for a download, or anything that is not text.
   *
   * The whole body never has to be held in memory at once, which is what
   * `network.binary` cannot avoid.
   */
  streamBinary: (
    options: NetworkRequestOptions,
  ): Promise<NetworkStream<Uint8Array>> =>
    open(options, "base64", (data) => decode(data)),

  /**
   * A WebSocket opened by the runtime rather than the page.
   *
   * The webview has its own `WebSocket` and it is the right tool when it can
   * do the job. It cannot set a header on the opening handshake, which is how
   * most APIs authenticate one - so the token goes in the query string, where
   * it ends up in the server's logs. This can set headers, and is not subject
   * to the page's origin rules.
   *
   * ```ts
   * const socket = await network.socket({
   *   url: "wss://api.example.com/live",
   *   headers: { authorization: `Bearer ${token}` },
   *   protocols: ["graphql-transport-ws"],
   * });
   *
   * socket.onMessage((data) => {
   *   if (typeof data === "string") handle(JSON.parse(data));
   * });
   * socket.onClose(({ code, error }) => { if (error) reconnect(); });
   *
   * await socket.send(JSON.stringify({ type: "subscribe", topic }));
   * ```
   *
   * Pings are answered by the runtime, so a socket stays up without the
   * application doing anything. Send latency is bounded at about 10ms: one
   * thread owns the socket, and a send waits for its read to come up for air.
   */
  socket: async (options: NetworkSocketOptions): Promise<NetworkSocket> => {
    const { signal, ...rest } = options;
    if (signal?.aborted) throw cancelled();

    let requestId: string | undefined;
    const opening = invokeTracked<RawSocket>("network.socket", rest, (id) => {
      requestId = id;
    });

    // Same two-phase shape as a stream: before the handshake completes there
    // is no socket to close, so the request is what gets abandoned.
    const abortHandshake = (): void => {
      if (requestId === undefined) return;
      void invoke("network.cancel", { id: requestId }).catch(() => {});
    };
    signal?.addEventListener("abort", abortHandshake, { once: true });

    let opened: RawSocket;
    try {
      opened = await opening;
    } finally {
      signal?.removeEventListener("abort", abortHandshake);
    }

    const socket = connect(opened);

    if (signal) {
      if (signal.aborted) void socket.close().catch(() => {});
      else {
        signal.addEventListener(
          "abort",
          () => {
            void socket.close().catch(() => {});
          },
          { once: true },
        );
      }
    }

    return socket;
  },
};

function connect(opened: RawSocket): NetworkSocket {
  const { id, url, protocol } = opened;
  const messageHandlers = new Set<(data: string | Uint8Array) => void>();
  const closeHandlers = new Set<(closed: NetworkSocketClosed) => void>();

  let pending: (string | Uint8Array)[] = [];
  let closed: NetworkSocketClosed | undefined;

  const stopMessages = listen<{
    id: number;
    data: string;
    binary: boolean;
  }>("network.message", (payload) => {
    if (payload.id !== id) return;
    const data = payload.binary ? decode(payload.data) : payload.data;
    if (messageHandlers.size === 0) {
      pending.push(data);
      return;
    }
    for (const handler of [...messageHandlers]) handler(data);
  });

  const stopClose = listen<{
    id: number;
    code: number | null;
    reason: string;
    error: string | null;
    cancelled: boolean;
  }>("network.socketClosed", (payload) => {
    if (payload.id !== id) return;
    stopMessages();
    stopClose();
    closed = {
      reason: payload.reason,
      cancelled: payload.cancelled,
      ...(payload.code === null ? {} : { code: payload.code }),
      ...(payload.error ? { error: payload.error } : {}),
    };
    for (const handler of [...closeHandlers]) handler(closed);
    messageHandlers.clear();
    closeHandlers.clear();
  });

  return {
    id,
    url,
    ...(protocol ? { protocol } : {}),

    send: (data) => invoke<null>("network.socketSend", { id, data }),
    sendBytes: (data) =>
      invoke<null>("network.socketSend", {
        id,
        data: encode(data),
        binary: true,
      }),

    onMessage(handler) {
      messageHandlers.add(handler);
      if (pending.length > 0) {
        const backlog = pending;
        pending = [];
        for (const message of backlog) handler(message);
      }
      return () => messageHandlers.delete(handler);
    },

    onClose(handler) {
      // Attaching after it has already closed still hears about it.
      if (closed) {
        handler(closed);
        return () => {};
      }
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },

    close: (code, reason) =>
      invoke<null>("network.socketClose", { id, code, reason }),
  };
}

async function open<Chunk>(
  options: NetworkRequestOptions,
  responseType: "text" | "base64",
  decodeChunk: (data: string) => Chunk,
): Promise<NetworkStream<Chunk>> {
  const { bytes, body, signal, ...rest } = options;

  if (signal?.aborted) throw cancelled();

  const params = {
    ...rest,
    responseType,
    ...(bytes === undefined ? {} : { bodyBase64: encode(bytes) }),
    ...(bytes === undefined && body !== undefined ? { body } : {}),
  };

  // Two phases, one signal. Before the head arrives there is no stream id to
  // cancel, so the request id is what gets abandoned; afterwards it is the
  // stream. The caller sees one `signal` and one `cancel()`.
  let requestId: string | undefined;
  const opened = invokeTracked<RawStreamHead>("network.stream", params, (id) => {
    requestId = id;
  });

  const abortHead = (): void => {
    if (requestId === undefined) return;
    void invoke("network.cancel", { id: requestId }).catch(() => {});
  };
  signal?.addEventListener("abort", abortHead, { once: true });

  let head: RawStreamHead;
  try {
    head = await opened;
  } finally {
    signal?.removeEventListener("abort", abortHead);
  }

  const { id, ...rest2 } = head;
  const stream = track(id, rest2, decodeChunk);

  if (signal) {
    // It may have aborted while the head was still on its way.
    if (signal.aborted) void stream.cancel().catch(() => {});
    else {
      signal.addEventListener(
        "abort",
        () => {
          void stream.cancel().catch(() => {});
        },
        { once: true },
      );
    }
  }

  return stream;
}

function track<Chunk>(
  id: number,
  head: NetworkStreamHead,
  decodeChunk: (data: string) => Chunk,
): NetworkStream<Chunk> {
  const chunkHandlers = new Set<(chunk: Chunk) => void>();
  const endHandlers = new Set<(end: NetworkStreamEnd) => void>();

  // Held until somebody is listening, so the first events of a stream are not
  // lost to an `await` between opening it and subscribing.
  let pending: Chunk[] = [];
  let ended: NetworkStreamEnd | undefined;

  const stopChunks = listen<{ id: number; data: string }>(
    "network.chunk",
    (payload) => {
      if (payload.id !== id) return;
      const chunk = decodeChunk(payload.data);
      if (chunkHandlers.size === 0) {
        pending.push(chunk);
        return;
      }
      for (const handler of [...chunkHandlers]) handler(chunk);
    },
  );

  const stopEnd = listen<{
    id: number;
    cancelled: boolean;
    error: string | null;
  }>("network.end", (payload) => {
    if (payload.id !== id) return;
    stopChunks();
    stopEnd();
    ended = {
      cancelled: payload.cancelled,
      ...(payload.error ? { error: payload.error } : {}),
    };
    for (const handler of [...endHandlers]) handler(ended);
    chunkHandlers.clear();
    endHandlers.clear();
  });

  return {
    ...head,
    id,

    onChunk(handler) {
      chunkHandlers.add(handler);
      // Whatever arrived before anyone was listening, in order.
      if (pending.length > 0) {
        const backlog = pending;
        pending = [];
        for (const chunk of backlog) handler(chunk);
      }
      return () => chunkHandlers.delete(handler);
    },

    onEnd(handler) {
      // Attaching after it already finished still hears about it, rather than
      // waiting for an event that has been and gone.
      if (ended) {
        handler(ended);
        return () => {};
      }
      endHandlers.add(handler);
      return () => endHandlers.delete(handler);
    },

    cancel: () => invoke<boolean>("network.cancelStream", { id }),
  };
}

async function send(
  options: NetworkRequestOptions,
  responseType: "text" | "base64",
): Promise<RawResponse> {
  const { bytes, body, signal, ...rest } = options;

  if (signal?.aborted) {
    throw cancelled();
  }

  const params = {
    ...rest,
    responseType,
    ...(bytes === undefined ? {} : { bodyBase64: encode(bytes) }),
    ...(bytes === undefined && body !== undefined ? { body } : {}),
  };

  if (!signal) return invoke<RawResponse>("network.request", params);

  let id: string | undefined;
  const answered = invokeTracked<RawResponse>(
    "network.request",
    params,
    (sent) => {
      id = sent;
    },
  );

  const abort = (): void => {
    if (id === undefined) return;
    // The runtime rejects `answered` itself, so there is nothing to do with
    // the outcome here - including the case where the request had already
    // finished and there was nothing left to cancel.
    void invoke("network.cancel", { id }).catch(() => {});
  };

  signal.addEventListener("abort", abort, { once: true });
  try {
    return await answered;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

const cancelled = (): VantailError =>
  new VantailError(ErrorCode.CANCELLED, "The request was cancelled");
