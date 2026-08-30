/**
 * The "model".
 *
 * It is a lookup table and a delay. Nothing here is trying to be convincing -
 * the point of this example is the window and the plumbing around it, and a
 * real model would only make it harder to see either.
 */

const CANNED: { match: RegExp; reply: string }[] = [
  {
    match: /title ?bar|titlebar|window/i,
    reply:
      "The bar at the top of this window is HTML. `titleBarStyle: \"hidden\"` " +
      "lets the page run to the top edge, and the runtime hands it the one " +
      "thing it cannot work out for itself: how much room the platform's " +
      "window buttons need. That arrives as a CSS variable before the first " +
      "paint, so even a page with no JavaScript gets it right.",
  },
  {
    match: /htmx|hypermedia/i,
    reply:
      "Every message here is a form post. The server answers with two " +
      "bubbles of HTML and htmx swaps them into the transcript. There is no " +
      "client-side state, no JSON, and no re-render - which is why the " +
      "interface has no idea it is inside a native window.",
  },
  {
    match: /bun|hono/i,
    reply:
      "Hono runs under Bun on a loopback port, and the window points at it. " +
      "Vantail does not care what is serving: it is a URL either way. A " +
      "packaged build ships that server as a compiled binary beside the " +
      "assets and a boot page starts it - ask about size for what that " +
      "costs.",
  },
  {
    match: /size|megabyte|\bmb\b|binary|small/i,
    reply:
      "The sidecar is 48MB, of which this application is about 27KB. The " +
      "rest is the Bun runtime that `--compile` embeds, and none of it comes " +
      "off: `strip` changes nothing and `--minify` saves 0.1MB. It " +
      "compresses well, so the `.dmg` is 21.8MB. That is the price of a real " +
      "server process, and this example pays it deliberately.",
  },
  {
    match: /tailwind|css|style/i,
    reply:
      "Tailwind builds the stylesheet before the server starts - into " +
      "`public/` for `bun run dev`, into `dist/` for a packaged app. The title " +
      "bar's padding is a utility that reads the runtime's inset variables, " +
      "so it is correct on macOS and on the platforms that leave nothing " +
      "reserved at all.",
  },
];

const FALLBACK = [
  "That is outside what this example knows - it has about five answers and " +
    "a lot of confidence. Ask about the title bar, htmx, Bun, or Tailwind.",
  "No idea. This is a lookup table in `src/replies.ts`, not a model.",
  "I have nothing for that one. The interesting part of this example is the " +
    "window, not the conversation.",
];

export function reply(message: string): string {
  const hit = CANNED.find((entry) => entry.match.test(message));
  if (hit) return hit.reply;
  return FALLBACK[Math.floor(Math.random() * FALLBACK.length)]!;
}
