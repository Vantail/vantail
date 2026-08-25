import { hid, mdns, secrets } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/** The OS credential store. */
export function secretsPanel(): Panel {
  const p = panel("secrets", "secrets", "The platform keychain, for tokens that should not sit in a file.");

  const key = p.input("key", "api-token");
  const value = p.input("value", "s3cr3t");
  p.row(
    key,
    value,
    p.button("set()", () => secrets.set(key.value, value.value)),
    p.button("get()", () => secrets.get(key.value)),
  );

  p.row(
    p.button("has()", () => secrets.has(key.value)),
    p.button("delete()", () => secrets.delete(key.value)),
  );

  p.note(
    "Stored in the Keychain on macOS, the Credential Manager on Windows, and the " +
      "Secret Service on Linux. A container without one is why this is the single " +
      "test the Linux suite skips.",
  );

  return p;
}

/** Finding things on the local network. */
export function mdnsPanel(): Panel {
  const p = panel("mdns", "mdns", "Discovering services advertised on the local network.");

  const service = p.input("service type", "_http._tcp.local");
  p.row(
    service,
    p.button("discover()", () => mdns.discover({ service: service.value, timeoutMs: 3000 })),
  );

  p.row(
    p.button("browse()", () => mdns.browse(service.value)),
    p.button("stop()", () => mdns.stop(service.value)),
    p.button("browsing()", () => mdns.browsing()),
  );

  p.note(
    "`discover` is a one-off with a deadline; `browse` keeps listening and reports " +
      "arrivals and departures below. A network with nothing advertising that type " +
      "returns an empty list, which is not an error.",
  );

  mdns.onFound((found) => p.log(`found ${found.name} at ${found.addresses?.join(", ") ?? "no address"}`));
  mdns.onLost((lost) => p.log(`lost ${lost.name}`));

  return p;
}

/** USB HID devices. */
export function hidPanel(): Panel {
  const p = panel("hid", "hid", "Talking to USB HID hardware directly.");

  p.row(
    p.button("list()", () => hid.list()),
    p.button("opened()", () => hid.opened()),
  );

  const id = p.input("device id", "");
  p.row(
    id,
    p.button("open()", async () => {
      const connection = await hid.open(id.value);
      connection.onInput((report) => p.log(`input: ${report.length} bytes`));
      connection.onClosed(() => p.log("device closed"));
      return `opened ${id.value}`;
    }),
  );

  p.note(
    "Run list() first and copy an id. This needs hardware, so an empty list here " +
      "means nothing is plugged in rather than something being wrong. The config " +
      "allows any device; a real app names the vendor it ships.",
  );

  return p;
}
