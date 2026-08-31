# Focus - a menu bar application

A pomodoro timer that lives in the menu bar, with the countdown beside the
icon. Vue 3, and no window most of the time.

```sh
pnpm dev
```

## The shape

This is the part worth copying. An application with no Dock icon, no taskbar
entry and no window at rest is four settings, none of them about the
interface:

```ts
showInDock: false,               // no Dock icon, no Cmd-Tab entry (macOS)
quitOnLastWindowClosed: false,   // closing the popover is not quitting
window: {
  visible: false,                // nothing appears at launch
  decorations: false,            // a panel, not a window
}
```

`showInDock` is the macOS accessory activation policy. It has to be decided
before the event loop starts running, which is why it is config rather than
something the page can turn on later - AppKit reads it once and ignores it
afterwards. `vantail package` also writes `LSUIElement` into the bundle, so a
packaged build behaves the same way before its first line of JavaScript runs.

Keeping the window out of the taskbar is a method rather than a setting, so
`src/main.ts` calls `appWindow.setSkipTaskbar(true)`. That is the same idea on
Windows and Linux, where there is no Dock to hide from.

## Placing the popover

`src/popover.ts` handles a units mismatch:

- `tray.onClick` reports the icon's position in **physical** pixels.
- `appWindow.setPosition` takes **logical** ones.

On a Retina display that is a factor of two. `screen.list()` closes the gap -
it reports each display's logical geometry next to its `scaleFactor` - and
which display the point is on decides the scale, so each one is tried until
the converted point lands inside its bounds.

Read the icon's position from every click rather than remembering it: the icon
moves as other applications add and remove their own.

## Clicking the icon

Clicking the icon while the popover is open delivers two signals in an order
nothing guarantees: the webview loses focus, and the click arrives. Left
alone they fight - the blur hides the popover, and the click then opens it
again.

`src/popover.ts` settles it on timing rather than order. A blur within 250ms
of opening belongs to the click that opened it and is ignored. A click within
400ms of a blur-close is the same gesture and closes rather than reopens.
Visibility is tracked locally rather than read back with `isVisible()`, which
is a round trip whose answer can change in flight.

## The countdown keeps running with the window shut

`tray.setTitle` puts text beside the icon. macOS is the only platform that
shows it, so elsewhere the countdown goes in the tooltip.

The popover and the menu bar are painted from one tick, so they cannot
disagree about the time.

The remaining time is counted from a wall-clock deadline rather than by
subtracting a second per tick. A hidden webview is throttled hard - a
one-second interval fires several seconds late - and counting ticks would
drift by however long the machine was busy or asleep. Counting down to a
timestamp is right whenever it happens to run.

Nothing on the tray menu shows the clock, so the menu is rebuilt only when
what it says changes.

## Two ways in, one set of commands

Everything the popover can do is also on the tray menu, because the menu is
what a right-click gives you and it has to stand on its own. Both call
`command()` in `src/menubar.ts`.

A tray menu is a snapshot rather than something live - "Start" would still say
Start after the timer had started - so it is rebuilt when the text it shows
would change, and not on every tick, which makes it flicker on the platforms
that rebuild it in place.

## Notes

- `menu.onClick` fires for any item with an id wherever it lives, so the tray
  menu does not need a listener of its own.
- The app menu is nearly empty but not absent: on macOS the predefined items
  are what make Cmd-Q work at all.
- The window is transparent and undecorated, so `src/style.css` draws the card,
  its border and its shadow. The body has to stay transparent or the rounded
  corners come back square.
- `vue-tsc` cannot drive TypeScript 7 yet - it loads the compiler through
  `typescript/lib/tsc`, which 7 no longer exports - so `pnpm typecheck` runs
  plain `tsc` over the `.ts` files and the SFC templates are not checked.
