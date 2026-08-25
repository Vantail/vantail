# Architecture

The whole of Vantail is one question answered well: **how does a call in
JavaScript reach the operating system and get back?**

## The path of a call

```ts
await filesystem.readText("/Users/jeroen/notes.txt");
```

1. **`@vantail/api`** turns that into a request and hands it to the bridge.

   ```json
   {
     "id": "01HZ...",
     "method": "filesystem.readText",
     "params": { "path": "/Users/jeroen/notes.txt" }
   }
   ```

   The promise is parked in a `Map` keyed by `id`.

2. **The bridge** - a small script the runtime injects before any page script
   runs - serialises it and calls `window.ipc.postMessage`. That is the
   webview's own channel to its host: no socket, no port, no server.

3. **The runtime's IPC handler** parses the message and hands it to the event
   loop as a user event, stamped with the label of the window it came from.
   The label is added here rather than sent by JavaScript, so a window cannot
   claim to be a different one. Parsing happens here too, so that a malformed
   message becomes an error response rather than a panic.

4. **The router** looks at the namespace and decides _where_ the call runs.
   Anything that blocks - currently all of `filesystem` - goes to a fixed
   worker pool. Everything else runs on the event loop thread, because that
   is the only thread allowed to touch the window.

5. **The handler** decodes its own params, asks the permission layer, and does
   the work. It always operates on the path the permission layer returned,
   never on the raw string from JavaScript.

6. **The response** travels back to the window that asked, as
   `evaluate_script`:

   ```js
   window.__VANTAIL__._dispatch(JSON.parse('{"id":"01HZ...","result":"..."}'));
   ```

   The payload is a string literal parsed with `JSON.parse`, so file contents
   can never close the string and become code.

7. **The SDK** finds the parked promise by `id` and resolves it - or rejects
   it with a `VantailError` built from the error payload.

## The bridge

The injected script knows nothing about methods, promises or errors. It is a
pipe with three operations: `postMessage`, `subscribe`, and `_dispatch`. All
the ergonomics live in `@vantail/api`, so new methods and event types arrive
with an SDK update alone.

The SDK can therefore load _late_. Anything the runtime dispatches before
`@vantail/api` subscribes is held in a backlog and delivered on subscription,
so a call made during module evaluation cannot lose its response.

## Windows

Every window is a `Window` plus a `WebView`, held together in one entry and
addressed by a label the application chose. `main` is created from the config
before the event loop starts; the rest come from `window.create`, which is why
`MainCtx` carries the event loop target - a window can only be created on the
thread that owns the loop.

```text
WindowManager
  +-- main      Window + WebView + tracked size
  +-- settings  Window + WebView + tracked size
  +-- ...
```

Two things follow from windows being separate webviews:

**Responses are routed, not broadcast.** A filesystem call that finishes on a
worker thread comes back to the window that made it, not to whichever window
happens to be focused. Window events (`resized`, `moved`, `focus`) go only to
the window they happened to. Lifecycle events (`created`, `ready`, `closed`)
go to all of them.

**Windows share nothing.** There is no common global, no shared memory, no
`window.opener`. `app.emit` is a round trip out to the runtime and back into
the other webview, which is the only path there is.

The size in each entry is tracked from resize events rather than queried,
because on macOS `Window::inner_size` keeps reporting the size the window was
created with even after it has actually resized.

### Window readiness

A window exists before its document does. Between `window.create` returning
and the new page's script running, anything sent to that window lands in the
bridge's backlog - and the bridge flushes that backlog on the next microtask
rather than the instant something subscribes, because a page typically
subscribes and _then_ registers its handlers.

`createWindow` waits for `window.ready`, emitted when the webview reports its
page finished loading, so by the time it resolves the new window can actually
receive a message. That removes the race rather than documenting it.

## Menus and the tray

Both live outside any window, both must be created and modified on the main
thread, and both vanish the moment their handle is dropped - so the event loop
owns them, in one `Chrome` struct.

They are also created _after_ the loop starts rather than before, because on
macOS neither exists until the application has actually launched.

`muda` and `tray-icon` deliver activations through global handlers rather than
through the window system, so the runtime installs handlers that push them
into the event loop as user events. From there a menu click is an event like
any other, broadcast to every window as `menu.click`.

## Processes

Starting a child is quick and happens on the event loop. Waiting for one is
not, and happens on a thread of its own - not on the worker pool, so a
long-running build cannot starve filesystem calls.

That waiter polls `try_wait` rather than blocking in `wait`, which sounds
worse and is better: `wait` would hold the child's mutex for the whole life of
the process, and `process.kill` would then be waiting on exactly the thing it
is trying to interrupt.

Handles are ids the runtime allocates, not OS pids. A pid can be recycled the
moment a process exits, and an application holding a stale one must not be
able to signal somebody else's process.

## Threading

There is one event loop, on the main thread, and it owns the window and the
webview. Two rules follow:

- **Nothing else may touch them.** Responses from worker threads are routed
  back through `EventLoopProxy::send_event`, and the event loop performs the
  `evaluate_script`.
- **Nothing slow may run on it.** Reading a large file on the event loop
  thread would stop the window painting. The worker pool is fixed-size rather
  than a thread per call, so a `for` loop in application code queues rather
  than spawning a thousand threads.

Native dialogs are the deliberate exception: they run on the event loop and
block it for as long as they are open. That is what a modal dialog does
anyway, and it keeps the platform code to one synchronous call.

## Loading the interface

**In development** the webview points at the Vite dev server. It is a real
webview against a real HTTP server, so HMR, React Refresh, source maps and
devtools all behave exactly as they do in a browser.

**In production** assets are served from disk through a custom protocol:

```text
vantail://localhost/index.html
vantail://localhost/assets/index-CI4aFmGh.js
```

The handler resolves each request inside the resource directory component by
component, so `..` can never climb above it, and falls back to `index.html`
for extensionless paths so client-side routing works.

Windows maps custom schemes onto `http://vantail.localhost/...`; the runtime
picks the right form for the platform.

## Configuration

`vantail.config.ts` is a TypeScript file that the CLI reads. The runtime does
not read TypeScript - it reads one flat `vantail.json`, generated by the CLI:

```text
vantail.config.ts --(@vantail/shared/load)--> validated config
                                                    |
                          +-------------------------+--------------+
                          v                                        v
              .vantail/dev/vantail.json                  Resources/vantail.json
              { dev: { url: ... } }                      { distDir: "dist" }
```

The runtime finds its config next to the executable, in `resources/`, or at
`../Resources/` for a macOS bundle - so a packaged app needs no arguments.

## The bundle

```text
My App.app/
  Contents/
    Info.plist
    MacOS/My-App          <- the precompiled runtime, copied verbatim
    Resources/
      vantail.json
      dist/...              <- the Vite build
```

Three ingredients, always the same three. On Windows and Linux the same pieces
land in a folder with the executable at the top and everything else under
`resources/`.

Nothing is compiled at package time. The runtime binary comes from
`@vantail/runtime-<platform>-<arch>`, an optional dependency so only the
current platform is downloaded.

## The updater

```text
check     GET the manifest, compare versions
download  GET the archive -> verify Ed25519 -> write to a staging directory
install   extract -> rename the old aside -> rename the new in -> relaunch
```

The ordering is the design. Verification happens over the downloaded bytes in
memory, before anything is written where it could be executed. The public key
is compiled into the application from its config, so the endpoint is not
trusted - only the key is.

`install` renames rather than deletes so a failure can be undone, and the
displaced copy is removed at the _next_ startup, since the process doing the
deleting is running out of it.

It is a compile-time feature. Turning it off removes the HTTP client and TLS,
which is most of what it costs.
