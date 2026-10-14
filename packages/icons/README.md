# @vantail/icons

Lucide-powered icons for [Vantail](https://github.com/Vantail/vantail)
applications — the complete file-backed Lucide catalogue (1890 icons in
lucide@1.57.0) with a vanilla DOM API and a React adapter that draw
identically.

```bash
# Inside the Vantail monorepo, dependents just add:
# "@vantail/icons": "workspace:^"
```

Application developers never install Lucide themselves; this package pins the
official `lucide` dependency and re-exports its artwork.

## Vanilla (any DOM app, including the showcase)

```ts
import { createIconElement, getIconSvg } from "@vantail/icons";

document.body.innerHTML = getIconSvg("house", { size: 20 });
document.body.append(createIconElement("settings", { size: 20, label: "Settings" }));
```

## React

```tsx
import { Icon, House } from "@vantail/icons/react";

// Dynamic by name (full catalogue; bundles it — see below):
<Icon name="house" size={20} />
<Icon name="settings" size={20} strokeWidth={1.5} />
<Icon name="folder-open" size={24} strokeWidth={1.5} color="rebeccapurple" />

// Static (best tree-shaking — only imported icons ship):
<House size={20} aria-label="Home" />
```

## Props and defaults

| Prop | Default | Notes |
| --- | --- | --- |
| `size` | `24` | Width/height in px. Non-finite or `<= 0` falls back to `24`. |
| `strokeWidth` | `2` | `0` is allowed. Negative/non-finite falls back to `2`. |
| `color` | `"currentColor"` | Sets `stroke`, so icons inherit text color. Empty falls back. |
| `label` | — | Accessible name. With it: `role="img"` + `aria-label`. Without it: `aria-hidden="true"` (decorative). |
| `className` | — | Appended to the built-in `vantail-icon` class. |

Extra SVG attributes (`data-*`, `aria-*`, …) pass through escaped. Labels and
colors are HTML-escaped, so `label='"><script>'` cannot break out of the
attribute.

## Names

Canonical Lucide kebab-case only: `house`, `settings`, `folder-open`. These
are the file-backed icons of the installed `lucide` version — every name in
`iconNames` has a `dist/esm/icons/<name>.mjs` file behind it.

Deprecated aliases are excluded even though the `lucide` root still exports
them: `Home`, `AlertTriangle`, `Trash2`, `ActivitySquare`, `CheckCircle` and
friends render the placeholder. No case-insensitivity — `House` and `HOUSE`
render the placeholder. `isIconName(value)` narrows, and `iconNames` lists
the full shipped set with TypeScript autocomplete.

Unknown names never throw during render: they draw a placeholder marked
`data-unknown="true"` and warn once per name in the console.

## Static vs dynamic imports

- Static (`import { House } from "@vantail/icons/react"`) ships only the
  imported icons — prefer it in production UI. Each component closes over
  its own artwork and never touches the name registry.
- Dynamic (`<Icon name={pick}>`, `getIconSvg(name)`, or the `icons` record)
  supports the full catalogue by name — and bundles all of it. That is the
  documented cost of name-based lookup.
- `sideEffects: false` is set so bundlers can drop unused icons. One
  caveat found while verifying: top-level `displayName` assignments on the
  static components defeated tree-shaking in the production bundler, so the
  generated components carry no `displayName` (DevTools shows the function
  name, e.g. `House`).

Measured with Vite 8 production builds (unminified; static includes the
React runtime shared by both fixtures):

| Import style | Bundle | Contents |
| --- | --- | --- |
| `import { House } from "@vantail/icons/react"` | 57.5 kB | one icon + runtime |
| `import { Icon } from "@vantail/icons/react"` | 833.3 kB | full 1890-icon catalogue |
| showcase icons panel (vanilla dynamic) | 486 kB js / 119 kB gzip | full app incl. catalogue |

## Regeneration and Lucide upgrades

The registry is generated, not maintained by hand:

- `packages/icons/scripts/generate-icons.mjs` reads the installed `lucide`
  package (no network) and writes `src/icons.generated.ts` (names, map,
  types) and `src/react.generated.ts` (static components).
- `pnpm --filter @vantail/icons run generate` regenerates; `pnpm run build`
  regenerates first, deterministically (re-running without a Lucide change
  is a no-op).
- `lucide` is declared as `^1.48.0` (same convention as the examples) and
  locked to 1.57.0 in `pnpm-lock.yaml`. To upgrade: bump the dependency,
  `pnpm install`, regenerate, run the package tests (they re-derive the
  eligible set from the installed package and fail on drift), and commit
  the regenerated files.

## Offline

Icons are JS data bundled at build time through Vite. No network fetch, no
CDN, no runtime download — packaged apps render icons offline.

## License

MIT. Lucide artwork is ISC — see `LICENSE-THIRD-PARTY`.
