import { ErrorCode, invoke, VantailError } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/**
 * Underneath the typed API.
 *
 * Every namespace in `@vantail/api` is a thin wrapper over one call: a method
 * name and a JSON payload. `invoke` is that call, exposed. It is the escape
 * hatch for a method the wrapper has not caught up with, and it is worth
 * seeing once, because it is the whole protocol.
 */
export function rawPanel(): Panel {
  const p = panel("raw", "invoke", "The single call every other API is built on.");

  const method = p.input("method", "os.platform");
  const params = p.input("params (JSON)", "{}");

  p.row(
    method,
    params,
    p.button("invoke()", () => invoke(method.value, JSON.parse(params.value || "{}"))),
  );

  p.row(
    p.button("a method that does not exist", () => invoke("os.nonsense")),
    p.button("bad parameters", () => invoke("filesystem.readText", { nothing: true })),
  );

  // Errors are the reason to branch on `code` rather than on the message: the
  // code is stable, the wording is not.
  p.row(
    p.button("catch it by code", async () => {
      try {
        await invoke("filesystem.readText", { path: "/etc/shadow" });
        return "unexpectedly allowed";
      } catch (cause) {
        if (VantailError.is(cause, ErrorCode.PERMISSION_DENIED)) {
          return `refused, as expected: ${cause.code}`;
        }
        return `some other failure: ${String(cause)}`;
      }
    }),
  );

  p.note(
    "Reach for the typed namespaces instead. This exists so nothing is unreachable " +
      "while the wrappers catch up, and so the shape of the protocol is visible.",
  );

  return p;
}
