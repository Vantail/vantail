import { invoke, listen } from "./transport.js";

export interface DiscoveredService {
  /** The service type that was searched for, e.g. `_hub._tcp.local.` */
  service: string;
  /** The instance name, with the service type stripped: `Living Room Hub`. */
  name: string;
  /** The full record name, which is what identifies it uniquely. */
  fullname: string;
  /** The advertised host, e.g. `hub.local.` */
  host: string;
  port: number;
  /** Every address the device answers on, sorted. IPv4 and IPv6. */
  addresses: string[];
  /** TXT record properties, which is where devices put their model and id. */
  txt: Record<string, string>;
}

export interface DiscoverOptions {
  /** A service type such as `_hub._tcp.local`. The trailing dot is optional. */
  service: string;
  /** How long to listen. Default 3000, capped at 60000. */
  timeoutMs?: number;
}

/**
 * Finding devices on the local network.
 *
 * Every device worth talking to announces itself over multicast DNS, and no
 * browser can hear it. The alternative is asking your user to type in an IP
 * address, which is why this is a platform capability.
 *
 * Vantail knows what a service type is and nothing about what answers to it -
 * discovering `_hub._tcp.local` is generic; knowing the result speaks CLIP v2
 * is your application's business.
 *
 * ```ts
 * const bridges = await mdns.discover({ service: "_hub._tcp.local" });
 * for (const bridge of bridges) {
 *   console.log(bridge.name, bridge.addresses[0], bridge.txt["bridgeid"]);
 * }
 * ```
 */
export const mdns = {
  /**
   * Listen for a fixed period and return everything that answered, deduplicated
   * by full name. Resolves when the time is up, not when the first device
   * replies - devices answer at their own pace.
   */
  discover: (options: DiscoverOptions) =>
    invoke<DiscoveredService[]>("mdns.discover", options),

  /**
   * Keep watching, and report devices as they appear and disappear.
   *
   * Use this when the list is on screen; use {@link mdns.discover} when you
   * just need the answer once. Resolves `{ started: false }` if that service
   * type is already being watched.
   */
  browse: (service: string) =>
    invoke<{ service: string; started: boolean }>("mdns.browse", { service }),

  /** Stop watching. `false` if it was not being watched. */
  stop: (service: string) => invoke<boolean>("mdns.stop", { service }),

  /** Service types currently being watched. */
  browsing: () => invoke<string[]>("mdns.browsing"),

  onFound: (handler: (service: DiscoveredService) => void) =>
    listen<DiscoveredService>("mdns.found", handler),

  onLost: (
    handler: (
      service: Pick<DiscoveredService, "service" | "name" | "fullname">,
    ) => void,
  ) =>
    listen<Pick<DiscoveredService, "service" | "name" | "fullname">>(
      "mdns.lost",
      handler,
    ),
};
