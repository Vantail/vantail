# Assistant - Bun, Hono, htmx and Tailwind

A fake AI chat assistant in a window whose title bar is part of the page.

```sh
bun run dev
```

Needs [Bun](https://bun.sh). Everything else installs with the workspace.

## What is worth looking at

**The title bar has no JavaScript behind it.** The runtime sets
`--vantail-titlebar-inset-left`, `--vantail-titlebar-height` and their
siblings on the document before the first paint, so a server-rendered page
can pad around the platform's window buttons in plain CSS. `src/app.css`
turns that into a Tailwind utility and `src/views.ts` uses it.

**And no JavaScript at all.** The runtime drags the window from the band a
hidden title bar left behind, so there is no client script to write.

**`dev.ts` replaces `vantail dev`.** That command starts Vite, which is the
right thing for a bundled front end and no use to a server-rendered one. So
this example does the job itself, and the job is small: build the assets,
listen on a port, and write the runtime a config whose `dev.url` is that
port. It uses `buildRuntimeConfig` and `resolveRuntimeBinary` - the same
functions the CLI uses - so the window gets its height, colour and menu from
`vantail.config.ts` exactly as it would through the CLI.

**Serve `/index.html`, not just `/`.** The runtime opens the dev URL with a
page appended. A server answering only `/` shows a 404 in a window with no
address bar to explain it.

## Building it

```sh
bun run package     # bun run build.ts && vantail package --no-build
```

A server-rendered application has a problem a bundled one does not: there is
no server on the machine that installs it. So the server ships *as* the
application.

`bun build --compile` writes `src/serve.ts` and the Bun runtime into a single
executable, `dist/server`, which needs nothing installed to run. `vantail
package --no-build` then bundles `dist/` wholesale into the app, so the binary
lands beside the assets - and `$RESOURCE/server` is how `permissions.shell`
names it.

What the window opens is not the application. It is `dist/index.html`, a boot
page whose whole job is to start that sidecar, wait for it to print which port
it took, and then replace itself with that URL. From there the window is on
`http://127.0.0.1:...` and everything is as it was in development, bridge
included - the runtime injects it into every document the window loads, not
just the first.

The port is the server's to choose and its to announce. A number picked in the
boot page could be taken; a number picked at build time could be taken on
somebody else's machine.

`src/server.ts` is the routes and nothing else - no port, no file system, no
runtime-specific anything. Serving the built assets from disk lives separately
in `src/static.ts`, because two different programs need it: the compiled
server, and the dev server in `dev.ts`. Keeping the routes free of both means
development and a packaged build cannot drift apart.

The packaged app needs no Bun installed: the binary carries its own.

**Serve `/index.html`, not just `/`.** The runtime opens the dev URL with a
page appended. A server answering only `/` shows a 404 in a window with no
address bar to explain it.

## What the sidecar costs

| | `.app` | `.dmg` |
|---|---|---|
| this example | 54 MB | 21.8 MB |

The binary is 48.3 MB, of which the application is about 27 KB. The rest is
the Bun runtime, and no build flag removes it - `strip` and `--minify` change
almost nothing. It compresses well, so the `.dmg` is less than half the
installed size.

That is the price of a real server process, and this example pays it on
purpose: a sidecar can reach the file system, hold a database open and keep a
long-lived connection, none of which survive being moved into a webview.

Routes that are pure functions of a `Request`, as these are, can skip it
entirely - bundle the Hono app into the page and stand in for
`XMLHttpRequest`, and the same application is 4.5 MB installed. That is a
different example from this one, which is here to show a server.

## What a sidecar is trusted with

Worth saying plainly, because this example teaches the pattern: the permission
layer does not follow a process it started. This server reads its own assets
and answers two routes, so there is nothing here to abuse - but in general a
sidecar's network access, file access and its own child processes are bounded
by nothing in `vantail.config.ts`. Once one takes instructions from the page
over a socket, that socket is the trust boundary and needs rules of its own.

See [A program you start is outside all of this](../../docs/permissions.md#a-program-you-start-is-outside-all-of-this).

## What is still missing

The sidecar is built for the machine that built it. Shipping to another
architecture means compiling the server for it too, which is
`bun build --compile --target=...` and a packaging matrix this example does
not have.
