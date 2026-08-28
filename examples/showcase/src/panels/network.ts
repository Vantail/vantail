import { network } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/**
 * HTTP made by the runtime rather than the webview.
 *
 * Which matters for two reasons: it is not subject to CORS, and it is subject
 * to the config's host list instead. `fetch` in the page still works and is
 * still the right tool for an API that sets CORS headers.
 */
export function networkPanel(): Panel {
  const p = panel("network", "network", "HTTP from the runtime, past CORS but inside an allow list.");

  const url = p.input("url", "https://example.com");
  p.row(
    url,
    p.button("request()", async () => {
      const response = await network.request({ url: url.value });
      return `${response.status}\n\n${String(response.body).slice(0, 600)}`;
    }),
  );

  p.row(
    p.button("json()", async () => {
      const response = await network.json({ url: "https://api.github.com/repos/Vantail/vantail" });
      return response.body;
    }),
    p.button("binary()", async () => {
      const response = await network.binary({ url: "https://example.com" });
      return response.body;
    }),
  );

  p.row(
    p.button("POST with a body", async () => {
      const response = await network.request({
        url: "https://example.com",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "the showcase" }),
      });
      return `${response.status}`;
    }),
  );

  p.row(
    p.button("timing and size", async () => {
      const response = await network.request({ url: url.value });
      return { timing: response.timing, bodyBytes: response.bodyBytes };
    }),
    p.button("redirects followed", async () => {
      const response = await network.request({ url: url.value });
      return response.redirects.length === 0 ? "no redirects" : response.redirects;
    }),
    p.button("headers, repeats intact", async () => {
      const response = await network.request({ url: url.value });
      return response.headerPairs;
    }),
  );
  p.note(
    "`headers` joins repeated names with a comma, which cannot be undone for " +
      "set-cookie. `headerPairs` is every line in order.",
  );

  p.row(
    p.button("cancel while it is running", async () => {
      const controller = new AbortController();
      // Abandoned before the answer can arrive.
      setTimeout(() => controller.abort(), 10);
      return network.request({ url: url.value, signal: controller.signal });
    }),
  );
  p.note("Aborting rejects with CANCELLED at once. The connection itself is dropped when the runtime next gets the chance.");

  p.row(
    p.button("stream() a response", async () => {
      const stream = await network.stream({ url: url.value });
      const chunks: string[] = [];
      const done = new Promise<{ cancelled: boolean; error?: string }>((end) =>
        stream.onEnd(end),
      );
      stream.onChunk((chunk) => chunks.push(chunk));
      const ended = await done;
      return {
        status: stream.status,
        chunks: chunks.length,
        bytes: chunks.join("").length,
        ...ended,
      };
    }),
    p.button("stream() then cancel it", async () => {
      const stream = await network.stream({ url: url.value });
      const done = new Promise<{ cancelled: boolean }>((end) => stream.onEnd(end));
      await stream.cancel();
      return done;
    }),
  );
  p.note("The head arrives first, then the body in chunks. This is how server-sent events are consumed at all - `network.request` would wait for a body that never ends.");

  const socketUrl = p.input("socket url", "wss://echo.websocket.org");
  p.row(
    socketUrl,
    p.button("socket() round trip", async () => {
      const socket = await network.socket({
        url: socketUrl.value,
        headers: { "x-vantail": "showcase" },
      });
      const first = new Promise<string | Uint8Array>((message) => {
        const stop = socket.onMessage((data) => {
          stop();
          message(data);
        });
      });
      await socket.send("hello from the showcase");
      const reply = await first;
      const closed = new Promise((end) => socket.onClose(end));
      await socket.close(1000, "done");
      return {
        protocol: socket.protocol ?? null,
        reply: typeof reply === "string" ? reply : `${reply.length} bytes`,
        closed: await closed,
      };
    }),
  );
  p.note("A header on the opening handshake is the thing the page's own WebSocket cannot do, which is how most APIs authenticate one.");

  p.row(p.button("a host that is not allowed", () => network.request({ url: "https://npmjs.com" })));
  p.note("The config allows example.com and api.github.com. Anything else is refused before a packet leaves. An app that must reach whatever host its user types says `allow: [\"*\"]`.");

  return p;
}
