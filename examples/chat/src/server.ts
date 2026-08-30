/**
 * The application, as a Hono app and nothing else.
 *
 * No file system, no port, no runtime-specific anything - just routes over
 * `Request` and `Response`. That is what lets the same app answer from two
 * very different places:
 *
 *   `bun run dev`   `Bun.serve` hands it real HTTP requests
 *   packaged        the page hands it the requests htmx was about to send
 *
 * Which one is in force decides whether the application ships a 48MB Bun
 * binary beside it or nothing at all - see the README. The routes do not
 * change either way, and that is the point of keeping this file free of
 * anything that only exists in one of them.
 */

import { Hono } from "hono";

import { reply } from "./replies.ts";
import { bubble, escape, greeting, page } from "./views.ts";

/**
 * Statuses are passed explicitly.
 *
 * `c.html(body)` leaves Hono to fill the status in, and on older Bun that
 * reaches `new Response` as 0 and throws before anything is sent - a blank
 * window with "Internal Server Error" in the corner and no address bar to
 * explain it. Saying 200 costs nothing and works on every version.
 */
export function createApp() {
  const app = new Hono();

  // Both paths, and `/index.html` is the one that matters when a server is
  // answering: the runtime opens the dev URL with a page appended, and a
  // server that only answers `/` gets a 404 in a window with no address bar.
  app.get("/", (c) => c.html(page(), 200));
  app.get("/index.html", (c) => c.html(page(), 200));

  app.post("/message", async (c) => {
    const form = await c.req.formData();
    const message = String(form.get("message") ?? "").trim();
    if (!message) return c.body(null, 204);

    // Both bubbles in one response, appended to the transcript. htmx swaps
    // the markup in; there is no client-side state to keep in step.
    return c.html(
      bubble("you", escape(message)) + bubble("assistant", reply(message)),
      200,
    );
  });

  app.post("/clear", (c) => c.html(greeting(), 200));

  return app;
}
