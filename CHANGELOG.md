# Changelog

Notable changes per release.

## Unreleased

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
