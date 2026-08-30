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

The one exception is `src/client.ts`, and all of it is about the window
rather than the interface: dragging and double-click-to-zoom are not things
CSS can offer, because `-webkit-app-region: drag` is a Chromium extension a
`WKWebView` does not implement.

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

Verified end to end: the packaged `.app` opens, starts
`Assistant.app/Contents/Resources/dist/server`, and answers `POST /message`
with both bubbles - with no Bun installed anywhere in the path.

**Serve `/index.html`, not just `/`.** The runtime opens the dev URL with a
page appended. A server answering only `/` shows a 404 in a window with no
address bar to explain it.

## What the sidecar costs

Measured, so nobody has to guess:

| | `.app` | `.dmg` |
|---|---|---|
| this example | 54 MB | 21.8 MB |

The binary is 48.3 MB of which the application is about 27 KB. The rest is the
Bun runtime, and none of it comes off - `strip` changes nothing because the
binary is already stripped, and `--minify` saves 0.1 MB. Nothing you write
makes an embedded runtime smaller. It does compress, which is why the `.dmg`
is less than half the installed size.

That is the standing price of shipping a real server process, and this example
pays it on purpose: a sidecar can reach the file system, hold a database open
and keep a long-lived connection, and none of those survive being moved into a
webview.

If your routes happen to be pure functions of a `Request`, as these ones are,
you can avoid the runtime entirely by bundling the Hono app into the page and
standing in for `XMLHttpRequest` so htmx runs against it unmodified - about a
hundred lines, and it brings the same application to 4.5 MB installed and
2.8 MB downloaded. That is a different example than this one, which is here to
show a server.

## What is still missing

The sidecar is built for the machine that built it. Shipping to another
architecture means compiling the server for it too, which is
`bun build --compile --target=...` and a packaging matrix this example does
not have.
