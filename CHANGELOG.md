# Changelog

Notable changes per release.

## Unreleased

Everything since v0.1.17.

### Added

- The runtime drags the window by itself. A window whose title bar is hidden
  is moved by the band that bar left behind, and a double click there
  maximises it. Controls are skipped. No application code needed.
- `data-vantail-drag` and `data-vantail-no-drag` opt a subtree in or out of
  that, anywhere on the page.
- A window is a fixed frame by default: the document does not scroll, does not
  rubber-band, and has no scrollbars. Panes inside it still scroll.
  `window.scroll: true` makes it behave as a page, and
  `data-vantail-scrollbar` keeps one element's scrollbars.
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
- The `showcase` and `vanilla` examples set `window.scroll: true`, being pages
  rather than fixed frames.

---

Releases before this file predate it; see the git history.
