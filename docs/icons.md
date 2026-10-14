# Icons

Lucide icons as a first-party API. Name an icon, size it, color it — no
separate Lucide install, no network fetch, no native changes.

```ts
// package.json
"dependencies": { "@vantail/icons": "workspace:^" }
```

```ts
// vanilla (any DOM app, including the showcase)
import { createIconElement, getIconSvg } from "@vantail/icons";

el.append(createIconElement("house", { size: 20, label: "Home" }));
```

```tsx
// React
import { Icon, House } from "@vantail/icons/react";

<Icon name="house" size={20} />
<House size={20} aria-label="Home" />
```

## Props

| Prop | Default | Notes |
| --- | --- | --- |
| `size` | `24` | Width/height in px. Non-finite or `<= 0` falls back to `24`. |
| `strokeWidth` | `2` | `0` allowed. Negative/non-finite falls back to `2`. |
| `color` | `"currentColor"` | Sets `stroke`, so icons inherit text color. |
| `label` | — | With it: `role="img"` + `aria-label`. Without: `aria-hidden`. |
| `className` | — | Appended to the built-in `vantail-icon` class. |

A decorative icon is the default: `<Icon name="search" />` is hidden from
assistive technology. A meaningful one is labelled:
`<Icon name="search" label="Search" />`.

## Names

Canonical Lucide kebab-case only — `house`, `settings`, `folder-open`.
`House` and `HOUSE` do not work and render the placeholder. `isIconName()`
narrows, `iconNames` lists the shipped set.

Unknown names never throw: they render a placeholder marked
`data-unknown="true"` and warn once per name in the console.

## Static vs dynamic

- Static (`import { House } from "@vantail/icons/react"`) ships only the
  imported icons. Prefer it in production UI.
- Dynamic (`<Icon name={pick}>`, the `icons` record) bundles the curated
  set (~57 icons). Small and deliberate — never the whole Lucide catalogue.

## Offline and licensing

Icons are JS data bundled at build time through Vite: no CDN, no runtime
download, packaged apps render offline. Artwork is Lucide (ISC); the
attribution lives in `packages/icons/LICENSE-THIRD-PARTY`. The `lucide`
dependency is pinned in `packages/icons/package.json`.

See `examples/showcase` (the **icons** panel) for sizes, strokes, colors,
text pairing, accessible markup, dynamic selection, and unknown-name
handling, and `packages/icons/README.md` for the full API.
