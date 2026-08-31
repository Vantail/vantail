# Changelog

Notable changes per release.

## Unreleased

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
  over to the application window.

### Changed

- The `player` example draws one menu button on Windows and Linux, the way
  Spotify does, instead of a row of titles. It also grants `permissions.menu`,
  which `menu.popup` needs and it did not have.

- Maximise and restore snap rather than animating, so the page is never left
  drawn at its old size while the window moves. `window.animateZoom: true`
  keeps the platform animation. macOS only.

### Fixed

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
