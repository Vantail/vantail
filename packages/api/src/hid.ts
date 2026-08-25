import { decode, encode, type BinaryInput } from "./binary.js";
import { invoke, listen } from "./transport.js";

export interface HidDeviceInfo {
  /** Opaque, platform-specific, and what `open` takes. */
  id: string;
  vendorId: number;
  productId: number;
  manufacturer: string | null;
  product: string | null;
  serialNumber: string | null;
  usagePage: number;
  usage: number;
  interface: number;
}

export interface HidConnection {
  /** The handle every call below takes. Not an OS handle. */
  readonly handle: number;
  readonly vendorId: number;
  readonly productId: number;

  /**
   * Send an output report. The **first byte is the report id** - use `0` for
   * devices that do not use numbered reports. Resolves with the byte count
   * the device accepted.
   */
  write(data: BinaryInput): Promise<number>;

  /** Send a feature report. Same report-id convention as `write`. */
  sendFeatureReport(data: BinaryInput): Promise<null>;

  /** Read a feature report. `length` excludes the report id. */
  getFeatureReport(reportId: number, length: number): Promise<Uint8Array>;

  close(): Promise<boolean>;

  /** Input reports as they arrive, including the report id byte. */
  onInput(handler: (data: Uint8Array) => void): () => void;

  /** The device closed - because you asked, or because it was unplugged. */
  onClosed(
    handler: (event: { reason: "closed" | "disconnected" }) => void,
  ): () => void;
}

/**
 * Raw access to USB HID devices.
 *
 * WebHID does not exist in the webviews Vantail runs on, so a control pad, a
 * foot pedal or a macro pad is simply unreachable from a page. This is the
 * one capability that is device-shaped, which is exactly why it stays generic:
 * Vantail knows what a HID report is and has never heard of any particular device. Your
 * application implements the protocol; the platform hands it bytes.
 *
 * ```ts
 * const [deck] = await hid.list();          // already filtered by permission
 * const connection = await hid.open(deck.id);
 *
 * connection.onInput((report) => decodeButtons(report));
 * await connection.write(new Uint8Array([0x02, 0x0b, 0x01]));
 * ```
 *
 * `list()` returns only devices `permissions.hid` allows - an application
 * permitted to talk to one vendor's hardware has no business learning what
 * else is plugged in.
 */
export const hid = {
  list: () => invoke<HidDeviceInfo[]>("hid.list"),

  open: async (id: string): Promise<HidConnection> => {
    const opened = await invoke<{
      handle: number;
      vendorId: number;
      productId: number;
    }>("hid.open", { id });
    return connection(opened.handle, opened.vendorId, opened.productId);
  },

  /** Everything this application currently has open. */
  opened: () =>
    invoke<
      { handle: number; id: string; vendorId: number; productId: number }[]
    >("hid.opened"),
};

function connection(
  handle: number,
  vendorId: number,
  productId: number,
): HidConnection {
  const forHandle = <T extends { handle: number }>(
    event: string,
    fn: (payload: T) => void,
  ) =>
    listen<T>(event, (payload) => {
      if (payload.handle === handle) fn(payload);
    });

  return {
    handle,
    vendorId,
    productId,

    write: (data) =>
      invoke<number>("hid.write", { handle, data: encode(data) }),
    sendFeatureReport: (data) =>
      invoke<null>("hid.sendFeatureReport", { handle, data: encode(data) }),
    getFeatureReport: async (reportId, length) =>
      decode(
        await invoke<string>("hid.getFeatureReport", {
          handle,
          reportId,
          length,
        }),
      ),
    close: () => invoke<boolean>("hid.close", { handle }),

    onInput: (fn) =>
      forHandle<{ handle: number; data: string }>("hid.input", ({ data }) =>
        fn(decode(data)),
      ),
    onClosed: (fn) =>
      forHandle<{ handle: number; reason: "closed" | "disconnected" }>(
        "hid.closed",
        ({ reason }) => fn({ reason }),
      ),
  };
}
