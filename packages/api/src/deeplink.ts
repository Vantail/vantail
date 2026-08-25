import { invoke, listen } from "./transport.js";

/**
 * Links to your application, from anywhere on the machine.
 *
 * Register a scheme in `vantail.config.ts` and `myapp://...` reaches you -
 * which is how a desktop application finishes an OAuth sign-in, since the
 * browser needs somewhere to send the user back to.
 *
 * ```ts
 * deepLink.onOpen((url) => {
 *   const code = new URL(url).searchParams.get("code");
 *   if (code) void exchangeForToken(code);
 * });
 * ```
 *
 * **Treat the URL as input from a stranger.** Any web page or program on the
 * machine can open one. The runtime guarantees only that the scheme is one of
 * yours; everything after that is unverified, so check the state parameter of
 * an OAuth callback rather than trusting it arrived.
 *
 * A link that launched the application arrives before any page exists. It is
 * held for you, and delivered as soon as you register a handler - so there is
 * no window in which the link that started the app can be missed.
 */
export const deepLink = {
  /**
   * Handle links, including any that arrived before this ran.
   *
   * Returns an unsubscribe function.
   */
  onOpen: (handler: (url: string) => void): (() => void) => {
    // Registered before subscribing: subscribing releases whatever the
    // runtime was holding, and a handler added afterwards would miss exactly
    // the link it was written for.
    const stop = listen<{ url: string }>("deeplink.open", ({ url }) =>
      handler(url),
    );

    if (arrived === undefined) {
      // First subscriber: ask the runtime for what it held, and remember it
      // so a handler registered later in this session still sees it.
      arrived = invoke<string[]>("deeplink.subscribe");
    }

    void arrived.then((urls) => {
      for (const url of urls) handler(url);
    });

    return stop;
  },

  /** The schemes this application registered. */
  protocols: () => invoke<string[]>("deeplink.protocols"),
};

/**
 * Links the application was started with.
 *
 * Cached so that every handler sees them, not only whichever one happened to
 * register first.
 */
let arrived: Promise<string[]> | undefined;

/** Only used by tests, to undo the module-level cache. */
export function resetDeepLinkState(): void {
  arrived = undefined;
}
