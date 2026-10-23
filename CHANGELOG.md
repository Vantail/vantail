# Changelog

Notable changes per release.

## Unreleased

### Security

- **A page from another site no longer gets the application's
  permissions.** A window that followed a link, a redirect or a mistyped URL
  to somebody else's page kept the bridge and the IPC channel, and the
  runtime answered that page's calls exactly as it answered the
  application's: whatever `filesystem`, `shell`, `secrets` or `network`
  scope the application held, that page held too, and it received shared
  state and `app.emit` broadcasts. Reproduced on Windows: a page served from
  another origin wrote a file through `filesystem.writeText` with nothing
  but `window.ipc.postMessage`.

  The runtime now trusts the application's own origin only - `distDir`, or
  the dev server in development. Another origin gets no bridge, its calls
  are dropped before they reach the router, and nothing is pushed to it.
  Routing and query strings within the application are unaffected. See
  [permissions](docs/permissions.md#only-the-applications-own-pages).

### Changed

- **Links to other sites open in the user's browser.** A plain
  `<a href="https://...">` used to take the application's whole window to
  that site, with nothing there leading back; `target="_blank"` and
  `window.open` got a bare window of the platform's making, with no bridge,
  no title and nothing the application could manage. A web page or a
  `mailto:` link now goes to the browser or mail client, however it was
  opened. Links within the application are followed as before, and so is
  any click the application's own handler called `preventDefault()` on, so
  a router keeps its links. A popup for anything else, including one of the
  application's own pages, is refused - that is what `createWindow` is for.
  See [permissions](docs/permissions.md#only-the-applications-own-pages).

- **pnpm reads its build-script allowlist again.** pnpm 10 stopped reading
  the `"pnpm"` field in `package.json`, so `onlyBuiltDependencies` was
  silently ignored and every pnpm command warned about it. The setting now
  lives in `pnpm-workspace.yaml`, with `@parcel/watcher` (from the Tailwind
  CLI in the `chat` example, which ships prebuilt binaries) listed as
  deliberately not built. Contributors only; nothing that ships changes.

- **The root README's API list is checked against the SDK.** It had fallen
  nine modules behind - `autostart`, `database`, `deepLink`, `fileDrop`,
  `path`, `power`, `privacy`, `screen` and `shortcut` - with nothing to
  notice. A test now fails when a module has no row, or when a row names a
  method `@vantail/api` does not have.

- **The feature-combination CI job fails on warnings.** It exists to catch
  code that uses an optional dependency without being gated, which usually
  shows up as a warning, and `cargo check` passes with warnings - buried
  under 10 to 40 dead-code warnings per build. Dead code is now judged in
  the default build only, where every capability is in, and the stripped
  builds run with `-D warnings`.

### Fixed

- **Certificates chaining through the distrusted emSign intermediates are
  rejected.** The private keys behind those intermediates are now public,
  and the HTTP client, the updater and WebSockets verify servers against the
  bundled `webpki-roots` store, which still allowed paths through them.
  `rustls-webpki` 0.103.16 rejects those keys outright (RUSTSEC-2026-0382)
  and `webpki-roots` 1.0.10 stops trusting them (RUSTSEC-2026-0381).
  Lockfile-only.

- **`rustls` 0.23.46, for four advisories published against 0.23.45.** None
  of them reaches the runtime as it is built today, so this is precaution
  rather than a fix anyone was exposed to - but the HTTP client, the updater
  and WebSockets ship this code to every application, so it is taken now
  instead of waiting for the monthly sweep. Lockfile-only.
  - RUSTSEC-2026-0349, a forged ServerHello steering later connections to
    the same host off the post-quantum key exchange: the record it poisons
    lives in the client's session store, and every TLS connection the
    runtime makes starts from a fresh one - one ureq agent per request, one
    rustls config per WebSocket.
  - RUSTSEC-2026-0348, Brotli certificate decompression: the `brotli`
    feature is not enabled.
  - RUSTSEC-2026-0347, application data after an ECH rejection: ECH is not
    enabled.
  - RUSTSEC-2026-0346, TLS secrets in `Debug` output of session values: only
    reachable through a custom session store, and there is none.

- **Two npm advisories in the examples.** `hono` 4.13.13 in `chat`
  ([GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7),
  a static path decoded twice slipping past middleware) and `source-map-js`
  1.2.2 under `tray`'s Vue compiler
  ([GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q),
  a crafted source map stalling the event loop). Neither is in a published
  `@vantail/*` package; both failed the weekly `pnpm audit`.

## 0.1.25

### Added

- **`privacy`: the macOS camera, microphone and screen recording prompts.**
  `privacy.status(kind)` reads the system's stored decision
  (`not-determined`, `authorized`, `denied`, `restricted`),
  `privacy.request(kind)` shows Apple's own prompt the first time and
  answers from the stored decision after that, and `privacy.openSettings()`
  opens Privacy & Security so the user can reverse a denial - the only way
  one can be reversed. The kinds are `microphone`, `camera` and `screen`;
  the rest of what macOS guards (accessibility, location, contacts) has no
  prompt for the runtime to call, so `openSettings()` is the whole flow
  there. This is the OS's decision, not the permission layer's, so there is
  no `permissions.privacy` flag. Off macOS, `status` answers `unsupported`
  and the other calls reject with `UNSUPPORTED`.

  Screen recording cannot tell "never asked" from "denied", so a first-ever
  `status("screen")` reads `denied` until the prompt has been answered.

- **`macos.microphoneUsageDescription` and `macos.cameraUsageDescription`**
  in `vantail.config.ts`, written into the packaged `Info.plist` as
  `NSMicrophoneUsageDescription` / `NSCameraUsageDescription`. Without the
  matching string macOS denies capture without ever prompting. Grants belong
  to the bundle that asked, so `vantail dev` and the installed `.app` keep
  separate decisions. See [macOS privacy](docs/macos-privacy.md).

- **`@vantail/icons`: the full Lucide catalogue as a first-party package.**
  1890 icons by name, with a vanilla API (`getIconSvg`, `createIconElement`)
  and a React one (`<Icon name>` plus a named component per icon) from
  `@vantail/icons/react`. Size, stroke and color props, accessible markup
  when given a `label`, and a placeholder rather than a throw for an unknown
  name. Static imports tree-shake down to the icons used; `<Icon name>`
  with a name only known at runtime pulls in the whole catalogue - measured
  with Vite at 57.5 kB against 833.3 kB. No network fetch and no separate
  Lucide install. See [icons](docs/icons.md).

- **Examples**: `camera` walks the `privacy.*` camera flow,
  `vantail-symbols` is a searchable browser over the icon catalogue, and
  `tasks` is a small React app using both icon import styles. The showcase
  gains privacy and icons panels.

### Fixed

- **`print.document` on Linux reports whether the job actually printed.**
  `{ printed: true }` came from the GTK dialog's answer, which only means
  the user pressed Print and the job started - a job that then failed still
  reported success. It now waits for the job to finish and answers from
  whether it failed. Thanks to geennoob for finding and fixing this.

## 0.1.24

### Added

- **`sharedState`: keyed state shared between every window.**
  The runtime owns the values; windows hold synchronised copies. `get` reads,
  `set` writes and broadcasts the change to every window (including the
  caller) over the same transport `app.emit` rides on, and `subscribe`
  delivers the current value at once and every change after - which makes
  wiring `useSyncExternalStore` trivial with no shim. This complements
  `app.emit` / `app.listen` rather than replacing it: those stay the
  fire-and-forget message bus.

  Reads need `permissions.sharedState.read`; writes need a matching
  `permissions.sharedState.write` pattern, where `*` stops at a `.` boundary
  (`demo.*` covers `demo.counter` but not `demo.counter.x`) and `**` crosses
  it. `persist: true` writes the store through to JSON under `$APPDATA` and
  hydrates it on launch, and needs `write` to be non-empty. Values must be
  JSON-serialisable. New error codes: `SHARED_STATE_KEY_DENIED`,
  `SHARED_STATE_NOT_SERIALIZABLE`, `SHARED_STATE_PERSIST_FAILED`. Last write
  wins; the store is per-application-instance.

  The React example gains an "Open sync window" demo proving it: a counter
  set in either window is reflected in the other without a reload.

- **`print.document`: printing through the native print dialog.** Give it
  an `html` string or a `pdfPath`, exactly one of the two, and the user
  chooses the printer, copies and page range - or cancels - in Edge's print
  preview on Windows, the print panel on macOS or the GTK dialog on Linux.
  The promise resolves when the dialog closes, with `{ printed }` saying
  whether they went through with it (`null` on Windows, where Edge's
  preview does not say).

  The content always renders in a view of its own, never one of the
  application's windows, and there is deliberately no call that prints the
  current window - so nothing a compromised page does can send the app's own
  UI to paper. That, plus a dialog the application cannot click through, is
  why there is no `permissions.print` flag. `pdfPath` still goes through
  `permissions.filesystem` read scope. Passing both sources or neither
  rejects with `INVALID_ARGUMENT`. See
  [permissions](docs/permissions.md#printing-has-no-permission).

  The `invoice` example prints both ways, and the showcase gains a print
  panel showing the working call next to the refused ones.

## 0.1.23

### Fixed

- **`tray.setIcon` with a `template` option changes the icon on Linux and
  Windows.** Template images are a macOS idea, and the call underneath did
  nothing at all elsewhere - not drawing the icon as a template, and not
  drawing it as anything else either, so the old icon stayed. The option is
  now ignored there and the icon is set. On macOS nothing changes: leaving
  `template` out still keeps the icon drawn the way it already was.

### Changed

- **Native dependencies moved forward**, including the window and webview
  layer: tao 0.37.1, wry 0.57, muda 0.21 and tray-icon 0.26 (which have to
  move together - tray-icon is built on muda's menu types), dirs 7, and patch
  releases of ureq, keyring, mdns-sd, interprocess, notify-rust and open. The
  runtime is now built with Rust 1.99; the minimum to build it from source is
  still 1.94.

  One edge on macOS: a tray created with `iconAsTemplate: true` but no
  `icon`, and given one later with `tray.setIcon(path)`, now draws it as-is.
  Pass `{ template: true }` to `setIcon` for a template image.

- **`npm create @vantail` scaffolds against Vite `^8.3.1`**, the range the
  examples are built and tested with.

## 0.1.22

### Fixed

- **TLS 1.3 handshake messages at the wrong encryption level are now
  rejected.** `rustls` 0.23.43 accepted a handshake message packed into the
  same record as the key-changing message before it, against RFC 8446 section
  5.1 (RUSTSEC-2026-0285). This is a lockfile-only patch to 0.23.45 - the same
  move the monthly dependency sweep would have made, taken now because the
  HTTP client, the updater and WebSockets all ship this code to every
  application.

- **A stale single-instance socket no longer blocks the next launch.**
  On macOS the single-instance lock is a socket file, and a crash or SIGKILL
  left it behind with nobody listening - so the next launch failed with
  `could not claim single instance: Address already in use (os error 48)`
  and ran without single-instance protection. An `AddrInUse` is now followed
  by another handover attempt (for a concurrent starter that just won the
  race), and only when nobody answers is the file treated as stale, removed,
  and bound again.

- **macOS windows are drawn with the current window chrome.** The runtime was
  linked against the macOS 14.5 SDK, and AppKit draws an application linked
  against a pre-26 SDK in compatibility mode on every later release:
  Sequoia's 28pt title bar and flat window buttons, while the windows around
  it have the taller bar and, on macOS 27, the redesigned ones (#3). It is
  now built on a `macos-26` runner and linked against the macOS 26 SDK, and
  the release pipeline checks the linked SDK so that a future runner change
  cannot quietly bring this back. Nothing changes for an application: the
  title bar is measured from the window rather than assumed, so a page keyed
  off `--vantail-titlebar-*` follows the taller bar on its own. Earlier macOS
  releases are unaffected.

## 0.1.21

### Added

- **Unsupported platforms are refused by name.** Vantail publishes a runtime
  for five targets, and `darwin-x64` is not one of them - so an Intel Mac
  cannot run a Vantail application. Until now it was told to
  `npm install @vantail/runtime-darwin-x64`, which 404s, because the package
  name was built by string concatenation and never checked against anything.

  `vantail doctor` now fails its platform check by name and lists the targets
  that exist, `npm create @vantail` refuses before writing a project rather
  than leaving one that cannot install, and `@vantail/runtime` throws
  `UnsupportedPlatformError` - distinct from `RuntimeNotFoundError`, because
  "there is nothing to install" and "it is not installed here" deserve
  different answers. Setting `$VANTAIL_RUNTIME_BIN` still works everywhere:
  someone who compiled the runtime themselves has already answered the
  question.

  The list comes from `platforms.json`, which ships inside `@vantail/runtime`
  and is what the release pipeline builds from, so it cannot drift from what
  was published. `supportedTargets()`, `supportedPlatformNames()` and
  `isSupportedPlatform()` are exported if an application wants to ask.

- **A scaffolded project ships a release workflow.** `npm create @vantail`
  writes `.github/workflows/release.yml`, which builds a `.dmg`, `.msi` and
  `.deb` on their own runners from one tag and attaches them to a draft
  release. There is no cross-compilation - each installer needs tooling that
  only exists on its own platform - so this is the part everyone was
  otherwise writing from scratch.

- [docs/distribution.md](docs/distribution.md): shipping one application to
  macOS, Windows and Linux, which platforms exist and at what tier, and what
  signing needs on each.

### Changed

- A path from JavaScript is now a distinct type inside the runtime, and only
  the permission check can turn one into a path the filesystem will accept.
  Nothing an application can see has changed. The filesystem sandbox rests on
  the handler using the checked path rather than the raw string, and until now
  that was a convention held up by review: a handler written later could have
  read the raw string, compiled, passed every test, and quietly escaped the
  scope. It no longer compiles.

- `@vantail/create` now depends on `@vantail/runtime`, so it can read the
  published platform list rather than carry a copy that would go stale.

### Removed

- The `window.current` IPC method. It returned the calling window's label and
  had no SDK wrapper, no documentation and no caller - the label has always
  reached the page another way, which is what `currentWindow()` reads. Only an
  application calling `invoke("window.current")` by hand is affected; use
  `currentWindow()`, which needs no permission and no round trip.

## 0.1.20

### Added

- `window.borderRadius` rounds a frameless window's corners and clips the page
  to the shape. A number rounds all four, or give each corner its own radius -
  `{ topLeft: 20, topRight: 4 }` - and anything left out stays square. macOS
  and Windows; ignored on a window that has a frame, and on Linux for now.

  Windows draws the shape as a window region rather than a layer, so its edges
  are hard where macOS anti-aliases them, a shaped window gives up the shadow
  Windows draws behind a frameless one, and its corners are square while it is
  maximised.

- A `splash` example: a frameless window with its own corner radii that hands
  over to an application window drawing its own title bar. React, Tailwind v4
  and shadcn/ui.

### Changed

- The `player` example draws one menu button on Windows and Linux, the way
  Spotify does, instead of a row of titles. It also grants `permissions.menu`,
  which `menu.popup` needs and it did not have.

- Maximise and restore snap rather than animating, so the page is never left
  drawn at its old size while the window moves. `window.animateZoom: true`
  keeps the platform animation. macOS only.

### Fixed

- **`createWindow` would not type-check a `backgroundColor`.** The runtime has
  always read it from the options a window is created with, and the docs have
  always said the options are the `window` block from the config, but
  `WindowOptions` was missing the field - so the one window that most needs it,
  a runtime-created one with a dark page, could not ask for it without a cast.

- **Windows: a window with a menu grew every time it was maximised and
  restored** - 20px of height per size limit put back, so 80px a cycle. The
  application menu is a real menu bar there, and it was being hung off
  frameless windows too, where it cannot be seen but where `AdjustWindowRectEx`
  still reserves a row for it that the window never takes back. A frameless
  window no longer gets one.

- Windows: hiding a window's title bar and showing it again grew it by a menu
  bar each time, for the same reason - the frame went and the menu bar in it
  stayed. The menu now follows the frame, and the page is the same size after
  the round trip as it was before.

- Windows: a window with a menu opened one menu bar shorter than the size it
  asked for, because the menu is installed after the window is made and takes
  its row out of the client area. The size asked for is now put back.

- Windows: a frameless window - `decorations: false`, or a hidden title bar -
  opened a title bar shorter than the size it asked for. Windows works out how
  much of a new window is frame while it is still being created, before the
  window procedure that says this one has none can answer, and nothing asked it
  to think again. Something now does.

- Windows: `minWidth`, `minHeight`, `maxWidth` and `maxHeight` from the config
  were not enforced at all. They decided the size the window opened at and
  nothing else, so the window could be dragged to any size from there. They are
  now limits, as they already were on macOS and Linux.

- A window's configured size limits were also forgotten the first time it was
  maximised, on every platform: the limits come off while a window is maximised
  and go back on restore, and what went back was nothing at all.

## 0.1.19

### Fixed

- `cargo clippy` failed on Linux and Windows, where `showInDock` was read only
  on macOS. What the setting does is unchanged.

## 0.1.18

Everything since v0.1.17.

Two defaults changed. An application upgrading gets both without doing
anything, so read these first:

- **A window no longer scrolls as a document.** It does not move on the wheel,
  does not rubber-band, and has no scrollbars. Panes inside it still scroll on
  their own `overflow`. A window that really is a page sets
  `window.scroll: true`.
- **A hidden title bar now drags the window on its own.** The band that bar
  left behind moves the window and a double click there maximises it, so an
  application that already wired `startDragging` on `pointerdown` should drop
  its handler or call `preventDefault()`.

### Added

- `data-vantail-drag` and `data-vantail-no-drag` opt a subtree in or out of
  dragging, anywhere on the page. `data-vantail-scrollbar` keeps one element's
  scrollbars.
- `showInDock` config option. `false` gives a macOS application no Dock icon
  and no Cmd-Tab entry, and writes `LSUIElement` into the packaged bundle.
- Six examples built around a shape of window: `tray` (Vue, menu bar app),
  `sidebar` (sidebar-split title bar), `workspace` (two-row title bar), `tabs`
  (tabs in the title bar), `player` (a tall media bar), and `chat` (Bun, Hono
  and htmx behind a compiled sidecar).
- The React example draws its own menu bar and window controls on Windows and
  Linux, where a hidden title bar takes both away.

### Fixed

- `tray.onClick` fired twice per click, once on press and once on release. It
  now fires once, on release.
- `vantail dev` resolves resource-relative paths - a tray icon, `$RESOURCE` -
  against the public directory, so they work before anything is built.

### Changed

- Examples no longer wire up their own window dragging.
- The `showcase` and `vanilla` examples, and the `npm create @vantail`
  templates, set `window.scroll: true`, being pages rather than fixed frames.

---

Releases before this file predate it; see the git history.
