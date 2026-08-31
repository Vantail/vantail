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

`chrome::tray_message` decides which library events become IPC events.
`tray-icon` reports a press and a release as two `Click`s differing only by
`button_state`; the release is the click, and hovering is dropped.

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
              { dev: { url }, distDir: public/ }          { distDir: "dist" }
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

## What the HTTP client deliberately is not

`network.*` buffers a response, streams it, or upgrades it to a WebSocket, and
does nothing else. Two things it does not do, on purpose:

**No interrupt mid-read.** Cancelling a request or a stream frees the
application at once, but the connection is dropped when the reader next comes
up for air. Interrupting a blocked socket read means owning the transport
rather than borrowing one, which is a much larger commitment than a stop
button is worth.

**No DNS, connect or TLS timings.** `timing` reports what the client can
actually measure. Splitting out the phases means a custom connector; numbers
that look precise and are guessed would be worse than the four honest ones.

## The cost of a WebSocket, measured

`network.socket` was very nearly not built, on the argument that a second
protocol means a new dependency and that the cost lands on every application
including the ones that only talk to a lamp. That argument was wrong, and it
is worth writing down why, because the same reasoning applies the next time.

The runtime already carries `rustls`, `webpki-roots`, `http` and `httparse`
for the HTTP client and the updater. A WebSocket needs all four and adds only
the protocol itself, so the marginal cost is small. Measured on
`aarch64-apple-darwin`, release profile:

| Build                | Size      | Delta   |
| -------------------- | --------- | ------- |
| default, before      | 3,311,792 |         |
| `+ socks`            | 3,328,576 | +16 KB  |
| `+ websocket`        | 3,378,432 | +65 KB  |
| both, the default now| 3,395,200 | +81 KB  |

2.5% for two capabilities that are otherwise impossible from a webview. Both
are on by default and both are still cargo features, so a build that wants
neither can say `--no-default-features`.

There is a second lesson in it. `socks` and `websocket` were first written as
opt-in features, which sounds like a careful compromise and is in fact no
decision at all: the published runtime is built by `.github/workflows/release.yml`
with default features, so an opt-in capability would have reached nobody. For
a runtime that ships as a prebuilt binary, "put it behind a flag" is a way of
not shipping something while appearing to have shipped it. Either it is in
`default` or it does not exist - so measure, then decide.

## Why SQLite is bundled, and why it is on by default

`database` is by far the largest optional capability. Measured on
`aarch64-apple-darwin`, release profile:

| Build                          | Size      | Delta    |
| ------------------------------ | --------- | -------- |
| `--no-default-features`        | 2,168,096 |          |
| default, before SQLite         | 3,395,264 |          |
| `+ database`, system libsqlite3| 3,397,056 | +1.8 KB  |
| `+ database`, bundled          | 4,318,368 | +885 KB  |

Linking against the system copy is almost free, and it was still the wrong
answer. macOS, Windows and Linux each ship a different SQLite, and each OS
release moves it: `RETURNING` needs 3.35, `STRICT` tables need 3.37, and a
JSON function that exists on one machine is a syntax error on another. A
framework whose whole claim is that the same application runs on three
platforms cannot hand the application a database whose SQL dialect depends on
which laptop it is running on - and the applications that want a real database
are exactly the ones keeping records they cannot afford to have silently
behave differently. So: one version, everywhere, for 885 KB.

On by default for the reason in the section above - a capability that is not
in `default` is not shipped, because the release workflow builds with default
features. An application that stores nothing can strip it, and the runtime is
2.1 MB with everything optional turned off.

The part that is genuinely load-bearing is the integer rule. SQLite's INTEGER
is 64-bit, JSON's number is a double, and the boundary between them is where a
ledger quietly loses money. Returning a rounded number is never acceptable, so
an integer that does not fit is an error naming the column, and `bigint: true`
asks for all of them exactly. That decision came from a downstream application
that hit the same edge in `sql.js` and had to pass `useBigInt` on every read.

## What encryption costs, measured

`database-encryption` swaps SQLite for SQLCipher, which needs a crypto
library. Measured on `aarch64-apple-darwin`, release profile:

| Build                                   | Size      | Delta     |
| --------------------------------------- | --------- | --------- |
| default                                 | 4,334,976 |           |
| `+ database-encryption` (vendored OpenSSL) | 7,598,976 | +3.19 MB |

That is a 75% increase, and it is the reason this one feature is off by
default while `socks`, `websocket` and `database` are on. The rule from those
three still holds - a non-default feature is not shipped by the release
workflow, so leaving this off means an application that needs encryption has
to build the runtime itself. That is a real cost and it is the open question
on this capability, not a settled answer.

The alternatives were weighed and are worse:

- **Link the system crypto** rather than vendoring. Nothing to bundle, but
  macOS ships no OpenSSL headers, Windows ships nothing SQLCipher speaks, and
  a Linux build would then depend on whatever `libssl` the machine has. The
  binary stops being portable, which is most of what it is for.
- **Per-platform crypto backends** - CommonCrypto on macOS, something else
  elsewhere. Much smaller, and three code paths with three risk profiles for
  a capability whose whole job is not being subtly wrong.
- **Encrypting values rather than the file.** Cheap, and it gives up every
  query, index and constraint on the encrypted columns - which is what the
  database was for.

The key handling is the part worth keeping whatever the packaging answer is:
the key is generated in the runtime, stored in the OS credential store, and
read back by the runtime. It never exists in the webview, so a compromised
page cannot exfiltrate it and use the file elsewhere.
