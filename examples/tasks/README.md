# Tasks — `@vantail/icons` in a real interface

A small todo app whose entire iconography comes from
[`@vantail/icons`](../../packages/icons). Where the Symbols example is the
catalogue browser, this is the other half: icons at work in navigation,
buttons, status, and empty states.

```sh
pnpm dev
```

## What it demonstrates

**Static imports** for fixed chrome — the icons that never change:

```tsx
import { House, Star, Plus, Trash } from "@vantail/icons/react";

<button aria-label="Add task">
  <Plus size={17} />
</button>
```

Static imports ship only the icons used — the production bundle stays small
because the other ~1880 never enter it.

**Dynamic lookup** for data-driven artwork — each task stores a canonical
kind name picked from a small curated row, rendered with:

```tsx
import { Icon } from "@vantail/icons/react";

<Icon name={task.icon} size={18} />
```

Dynamic lookup spans the full catalogue (and bundles it — the documented
tradeoff, so it belongs on data, not chrome). Unknown names draw the
placeholder instead of crashing, which is also what makes stored tasks robust
across Lucide upgrades: kinds are revalidated with `isIconName` on load and
fall back to the default rather than vanishing.

**Icon props** in context: `size` for visual hierarchy (20px toggles, 17px
buttons, 40px empty state), `color` for the starred state, and `label` left
off on purpose — every icon here is either `aria-hidden` decoration next to
visible text, or sits inside a button whose `aria-label` names the action.
The one exception would be a standalone meaningful icon, which would take
`label="..."` for `role="img"` + `aria-label`.

## The app itself

Add/toggle/star/delete tasks, filter by All/Starred/Done, search, copy the
visible list as plain text (via `clipboard.writeText`, the config's only
permission), and clear finished tasks. State persists in `localStorage`;
corrupt or unavailable storage degrades to an empty list.

## Tests

Pure logic (creation, filters, counts, copy text, storage round-trips) lives
in dependency-free `src/tasks.ts` and is covered by `node --test`:

```sh
node --test test/tasks.test.js
```
