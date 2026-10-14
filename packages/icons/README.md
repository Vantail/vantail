# @vantail/icons

Lucide-powered icons for [Vantail](https://github.com/Vantail/vantail)
applications — one curated set of canonical Lucide icons with a vanilla DOM
API and a React adapter that draw identically.

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

// Dynamic by name (bundles the curated set):
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

Canonical Lucide kebab-case only: `house`, `settings`, `folder-open`. No
aliases, no case-insensitivity — `House` and `HOUSE` render the placeholder.
`isIconName(value)` narrows, and `iconNames` lists the shipped set.

Unknown names never throw during render: they draw a placeholder marked
`data-unknown="true"` and warn once per name in the console.

## Static vs dynamic imports

- Static (`import { House } from "@vantail/icons/react"`) ships only the
  imported icons — prefer it in production UI.
- Dynamic (`<Icon name={pick}>` or the `icons` record) bundles the curated
  set (~57 icons). That is small and deliberate; it never pulls the whole
  ~1500-icon Lucide catalogue.
- `sideEffects: false` is set so bundlers can drop unused icons.

## Offline

Icons are JS data bundled at build time through Vite. No network fetch, no
CDN, no runtime download — packaged apps render icons offline.

## License

MIT. Lucide artwork is ISC — see `LICENSE-THIRD-PARTY`.
