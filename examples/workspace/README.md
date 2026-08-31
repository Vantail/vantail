# Workspace - a two-row title bar

A dark command bar with a lighter tab strip under it, after the shape most
Windows productivity apps use. Both rows are the title bar.

```sh
pnpm dev
```

## The one number that matters

```ts
titleBarHeight: COMMAND,   // 48 - the first row, not 88
```

The chrome is two bands, but `titleBarHeight` is the height of the **first**
one. The runtime uses it to place the platform's window buttons, so it is the
height of the row those buttons belong in. Passing `COMMAND + TABS` would
centre the macOS traffic lights across the whole chrome and leave them
floating over the tab strip.

`src/titlebar.ts` owns both constants and `vantail.config.ts` imports
`COMMAND` from it, so the config and the stylesheet cannot drift apart. The
config is loaded through esbuild, so a relative import there is bundled rather
than resolved at runtime.

The runtime knows nothing about the second row. It is ordinary page content
that happens to sit above everything else and to drag the window like the row
above it.

## The same design on three platforms

The reference for this example is a Windows screenshot, with caption buttons
on the trailing edge. That is not something to reproduce literally:

- **Windows and Linux** - `insetLeft` is `0`, meaning the platform reserved no
  room and drew no buttons, so `WindowControls.tsx` draws minimise, maximise
  and close on the trailing edge. Close turns red, the hit areas are square
  and full height, and they sit hard against the corner.
- **macOS** - the traffic lights are still in the top-left corner, inside the
  command bar. The bar's leading content is padded by `insetLeft` to clear
  them, and no caption buttons are drawn: a second set beside the platform's
  own is worse than useless.

`insetLeft === 0` is the test rather than the platform's name. It stays right
if a platform changes its mind, and it is also right in a browser under
`vite dev`, where there is no window at all.

## Both rows drag

The runtime drags the band a hidden title bar left behind, which is
`titleBarHeight`, which is the command bar. The tab strip sits below it, so it
opts in:

```tsx
<div className="tabbar" data-vantail-drag>
```

The tabs are `role="tab"`. That is the right ARIA, and it is what keeps them
clickable - a bare `<div>` reads as background, and the window would move
instead of the tab being chosen.

## Notes

- The workspace pickers are drawn by the page rather than opened with
  `menu.popup`. They sit inside the bar and have to line up with it, and a
  platform popup is placed by the platform. `menu.popup` is the right tool
  when the menu is the platform's kind - a context menu on a right click.
- Cmd-T and Cmd-W are menu items rather than key handlers. On macOS a shortcut
  only exists because a menu item claims it, and claiming Cmd-W is what stops
  the platform closing the whole window when the user meant to close a tab.
- Closing a tab selects its neighbour rather than the first tab: the one
  beside the one you shut is where you were looking. Closing the last one
  closes the window.
- The caption buttons follow `appWindow.onResized` rather than only the button
  that changed the state, because the window can also be zoomed by
  double-clicking the bar or by the platform's own gesture.
- `backgroundColor` matches the command bar rather than the page. It is what
  shows before the first paint, and the top of the window is where a resize
  exposes it first.
