# Changelog

Notable changes per release.

## Unreleased

### Added

- `window.borderRadius` rounds a frameless window's corners and clips the page
  to the shape. A number rounds all four, or give each corner its own radius -
  `{ topLeft: 20, topRight: 4 }` - and anything left out stays square. macOS
  only; ignored on a window that has a frame.

- A `splash` example: a frameless window with its own corner radii that hands
  over to the application window.

### Changed

- Maximise and restore snap rather than animating, so the page is never left
  drawn at its old size while the window moves. `window.animateZoom: true`
  keeps the platform animation. macOS only.

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
