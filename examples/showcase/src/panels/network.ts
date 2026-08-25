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

  p.row(p.button("a host that is not allowed", () => network.request({ url: "https://npmjs.com" })));
  p.note("The config allows example.com and api.github.com. Anything else is refused before a packet leaves.");

  return p;
}
