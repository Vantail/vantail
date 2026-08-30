/**
 * What a packaged window opens: a page whose only job is to start the server
 * and then get out of the way.
 *
 * In development the window points straight at Hono, because something is
 * already running it. A packaged application has no such luxury - there is no
 * `bun run dev` and no Bun on the machine - so the server ships as a compiled
 * sidecar inside the bundle and this starts it.
 *
 * The sequence is: spawn `$RESOURCE/server`, wait for it to say which port it
 * took, then replace this document with that URL. From there the window is on
 * `http://127.0.0.1:...` and everything is as it was in development. The
 * bridge survives the navigation - the runtime injects it into every document
 * the window loads, not just the first.
 */

import { process as run } from "@vantail/api";

const say = (text: string) => {
  const status = document.getElementById("status");
  if (status) status.textContent = text;
};

async function start() {
  // The port is the server's to choose and its to announce: a number picked
  // here could be taken, and a number picked at build time could be taken on
  // somebody else's machine.
  const child = await run.spawn("$RESOURCE/server", []);

  let buffered = "";
  const done = new Promise<string>((resolve, reject) => {
    child.onStdout((chunk) => {
      buffered += chunk;
      const match = buffered.match(/listening on (http:\/\/\S+)/);
      if (match) resolve(match[1]!);
    });
    child.onStderr((chunk) => console.error("[server]", chunk));
    child.onExit((event) => {
      reject(new Error(`the server exited with ${event.code ?? "no code"}`));
    });
    setTimeout(() => reject(new Error("the server did not answer in time")), 10_000);
  });

  const url = await done;
  say("Starting…");
  location.replace(url);
}

start().catch((error: unknown) => {
  say(
    `Could not start the server: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
});
