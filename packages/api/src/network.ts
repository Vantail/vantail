import { decode, encode, type BinaryInput } from "./binary.js";
import { invoke } from "./transport.js";

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
  body: Body;
}

interface RawResponse {
  url: string;
  status: number;
  statusText: string;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  encoding: "text" | "base64";
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
 */
export const network = {
  /** Send a request and read the response as text. */
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

  /** The same, with the body as bytes. */
  binary: async (
    options: NetworkRequestOptions,
  ): Promise<NetworkResponse<Uint8Array>> => {
    const response = await send(options, "base64");
    return { ...response, body: decode(response.body) };
  },
};

async function send(
  options: NetworkRequestOptions,
  responseType: "text" | "base64",
): Promise<RawResponse> {
  const { bytes, body, ...rest } = options;
  return invoke<RawResponse>("network.request", {
    ...rest,
    responseType,
    ...(bytes === undefined ? {} : { bodyBase64: encode(bytes) }),
    ...(bytes === undefined && body !== undefined ? { body } : {}),
  });
}
