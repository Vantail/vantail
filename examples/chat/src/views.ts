/**
 * The HTML, as functions returning strings.
 *
 * No template engine and no JSX: an htmx application's views are small, and
 * the whole exchange is easier to follow when a route's answer is the markup
 * it sends rather than something compiled on the way out.
 */

const escapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Anything that came from the person typing goes through this. */
export const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => escapes[char]!);

export function bubble(role: "you" | "assistant", text: string): string {
  const mine = role === "you";
  return `
    <div class="flex ${mine ? "justify-end" : "justify-start"}">
      <div class="max-w-[46rem] rounded-2xl px-4 py-3 leading-relaxed ${
        mine
          ? "bg-accent/90 text-white rounded-br-sm"
          : "bg-raised text-ink rounded-bl-sm"
      }">
        <p class="text-[11px] uppercase tracking-wider ${
          mine ? "text-white/70" : "text-dim"
        } mb-1">${mine ? "You" : "Assistant"}</p>
        <div class="whitespace-pre-wrap">${text}</div>
      </div>
    </div>`;
}

/**
 * The title bar.
 *
 * `titlebar-inset` is the utility in `app.css` that pads by the runtime's
 * `--vantail-titlebar-inset-*` variables, so the controls clear the platform's
 * window buttons on macOS and sit hard against the edge where there are none.
 *
 * `data-drag` is what `client.ts` looks for: anything inside it that is not a
 * control drags the window.
 */
function titlebar(): string {
  return `
    <header
      data-drag
      class="titlebar-inset flex shrink-0 items-center gap-3 border-b border-line bg-canvas select-none"
      style="height: var(--vantail-titlebar-height, 52px)"
    >
      <span class="size-2.5 rounded-full bg-emerald-400" aria-hidden="true"></span>
      <div class="min-w-0">
        <p class="truncate text-sm font-semibold leading-tight">Assistant</p>
        <p class="truncate text-xs text-dim leading-tight">Nothing is being sent anywhere</p>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <button
          type="button"
          class="rounded-md px-2.5 py-1.5 text-xs text-dim hover:bg-raised hover:text-ink"
          hx-post="/clear"
          hx-target="#transcript"
          hx-swap="innerHTML"
        >Clear</button>
      </div>
    </header>`;
}

function composer(): string {
  return `
    <form
      class="shrink-0 border-t border-line bg-canvas p-3"
      hx-post="/message"
      hx-target="#transcript"
      hx-swap="beforeend"
      hx-on::after-request="this.reset(); this.message.focus()"
    >
      <div class="flex items-end gap-2 rounded-2xl border border-line bg-raised p-2">
        <textarea
          name="message"
          rows="1"
          required
          placeholder="Ask about the title bar, htmx, Bun or Tailwind"
          class="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-dim"
          onkeydown="if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.form.requestSubmit(); }"
        ></textarea>
        <button
          type="submit"
          class="rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-white hover:bg-accent/90"
        >Send</button>
      </div>
    </form>`;
}

export function greeting(): string {
  return bubble(
    "assistant",
    "This window's title bar is part of the page. Ask me about it, or about " +
      "htmx, Bun or Tailwind - I have canned answers for those and very " +
      "little else.",
  );
}

export function page(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Assistant</title>
    <link rel="stylesheet" href="/app.css" />
    <script src="/htmx.js" defer></script>
    <script type="module" src="/client.js"></script>
  </head>
  <body class="h-full">
    <div class="flex h-full flex-col">
      ${titlebar()}
      <main id="transcript" class="flex-1 space-y-4 overflow-y-auto p-4">
        ${greeting()}
      </main>
      ${composer()}
    </div>
  </body>
</html>`;
}

/**
 * The page a packaged window opens.
 *
 * Not the application: the application comes from the server, and the server
 * is not running yet. This starts it and then replaces itself - see
 * `boot.ts`. It is deliberately styleless beyond a colour, because it should
 * be on screen for a few hundred milliseconds and looking like a splash
 * screen would only make it feel longer.
 */
export function bootPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Assistant</title>
    <style>
      html, body { height: 100%; margin: 0; background: #0b0d12; color: #9aa1ad; }
      body { display: grid; place-items: center; font: 13px/1.5 system-ui, sans-serif; }
    </style>
    <script type="module" src="/boot.js"></script>
  </head>
  <body><p id="status">Starting\u2026</p></body>
</html>`;
}
