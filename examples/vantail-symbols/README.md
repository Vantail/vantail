# Vantail Symbols — a Lucide icon browser

An SF Symbols-style developer utility for discovering the icons shipped by
[`@vantail/icons`](../../packages/icons): search the complete bundled Lucide
catalogue, inspect an icon at different sizes and strokes, and copy
ready-to-use Vantail code.

```sh
pnpm dev
```

## Layout

- **Sidebar** — All Icons, Favorites, Recently Viewed. There are no
  categories: the icon package exposes canonical names and artwork, not
  category metadata, and inventing categories would rot on the next Lucide
  upgrade.
- **Icon grid** — the full `iconNames` catalogue in catalogue order, rendered
  in pages of 240 behind an intersection observer so a 1890-icon catalogue
  never renders all at once. Arrow keys move between cells; `Enter` selects.
- **Inspector** — large preview, size (16–96) and stroke-width (0.5–3)
  sliders, color presets plus a custom picker, light/dark/system preview
  backgrounds, one-click Vanilla and React copy actions that bake in the
  current settings, and a favorite toggle.

`/` focuses search, `f` favorites the selected icon, `Esc` clears.

## Catalogue

The single source of truth is `@vantail/icons`: `iconNames` for the list,
`isIconName` for validation, `getIconSvg` for rendering. Nothing here
duplicates SVG data or keeps a second registry, so a Lucide upgrade flows
through automatically after the icons package regenerates.

Unknown names can never crash the browser: stored favorites and recents are
validated against `isIconName` on load (a rename upstream silently drops the
stale entry), and search misses render an explicit empty state.

## Code generation

Both snippets use only documented public APIs:

```ts
import { getIconSvg } from "@vantail/icons";
```

```tsx
import { Icon } from "@vantail/icons/react";
```

Non-default size, stroke width, and color are baked into the snippet;
defaults are omitted. There is also a plain "Copy name" action for the
canonical kebab-case name.

Copying goes through `clipboard.writeText` under Vantail (the config grants
only the `clipboard` permission), with a web-clipboard fallback when the
page runs in a plain browser. Failures surface in the status toast rather
than pretending to succeed.

## Local state

Favorites (unbounded) and recently-viewed (most-recent-first, de-duplicated,
capped at 24) persist in `localStorage` — no backend, no account, no sync.
`localStorage` needs no permission and works offline; entries are revalidated
on every launch, and corrupt or unavailable storage degrades to empty lists.

## Tests

Pure logic (search, snippet generation, option clamping, favorites/recents,
storage round-trips) lives in dependency-free `src/lib.ts` and is covered by
`node --test`:

```sh
node --test test/symbols.test.js
```
