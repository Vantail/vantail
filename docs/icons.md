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
narrows, `iconNames` lists all 1890 shipped names with autocomplete.

The catalogue is every file-backed icon of the installed `lucide` version;
deprecated aliases (`Home`, `AlertTriangle`, …) are excluded.

Unknown names never throw: they render a placeholder marked
`data-unknown="true"` and warn once per name in the console.

## Static vs dynamic

- Static (`import { House } from "@vantail/icons/react"`) ships only the
  imported icons — about one icon plus runtime. Prefer it in production UI.
- Dynamic (`<Icon name={pick}>`, `getIconSvg(name)`, the `icons` record)
  supports the full catalogue by name and bundles all of it (~830 kB
  unminified for the registry; the showcase's dynamic icons panel builds
  to 486 kB js / 119 kB gzip for the whole app).

## Maintenance

The registry is generated from the installed `lucide` package — see
`packages/icons/README.md` ("Regeneration and Lucide upgrades"). After a
Lucide upgrade, regenerate and run the package tests; they fail if the
catalogue drifts.

## Offline and licensing

Icons are JS data bundled at build time through Vite: no CDN, no runtime
download, packaged apps render offline. Artwork is Lucide (ISC); the
attribution lives in `packages/icons/LICENSE-THIRD-PARTY`. The `lucide`
dependency is pinned in `packages/icons/package.json`.

See `examples/showcase` (the **icons** panel) for sizes, strokes, colors,
text pairing, accessible markup, a searchable full-catalogue gallery, and
unknown-name handling, and `packages/icons/README.md` for the full API.
