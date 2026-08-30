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

`src/popover.ts` is the only genuinely fiddly part, and the reason is a units
mismatch worth knowing about:

- `tray.onClick` reports where the icon is in **physical** pixels.
- `appWindow.setPosition` takes **logical** ones.

On a Retina display that is a factor of two, so passing the click straight
through puts the popover off the bottom-right of the screen - and it looks
perfectly correct on any machine that is not Retina, which is the worst way
for a bug to behave.

`screen.list()` closes the gap: it reports each display's logical geometry
next to its `scaleFactor`. Which display the point is on is what decides the
scale, and the only way to tell is to try each one and see whose bounds the
converted point lands in.

The icon's position has to be read from the click every time rather than
remembered, because the icon moves as other applications add and remove their
own.

## Clicking the icon

Two things had to be right before a left click could open the popover and
leave it open.

**One click is one event.** `tray_icon` reports a press and a release as two
`Click` events differing only by `button_state`, and the runtime forwarded
both - so every listener received two `tray.click`s per click. A handler that
shows a window cannot tell; one that *toggles* opens on the press and shuts
again on the release. Fixed in the runtime (`chrome::tray_message`): the
release is the click.

**Blur and click race.** Clicking the icon while the popover is open produces
two signals in an order nothing guarantees: the webview loses focus, and the
click is delivered. Handled naively they fight - the blur hides the popover
and the click then opens it again, so the icon appears not to close it.

`src/popover.ts` settles it with two guards, both about time rather than
order. A blur within 250ms of opening is the tail of the click that opened it,
so it is ignored. A click within 400ms of a blur-close is that same gesture -
the blur lands on the press, the click on the release - so it closes rather
than reopening. Visibility is tracked locally rather than read back with
`isVisible()`, because that is a round trip and the answer can change while it
is in flight.

## The countdown keeps running with the window shut

`tray.setTitle` puts text beside the icon. macOS is the only platform that
shows it, so elsewhere the countdown goes in the tooltip instead.

The popover and the menu bar are painted from **one** tick. They used to have
an interval each - 250ms for the dial, 1000ms for the title - which meant two
readings of the same value taken up to a second apart, so the two disagreed
about the time. A countdown that disagrees with itself is worse than none.

The remaining time is counted from a wall-clock deadline rather than by
subtracting a second per tick, and that is not defensive coding - it is
load-bearing. A hidden webview is throttled hard: measured here, a one-second
interval fired at roughly 2, 4 and 3 second gaps while the popover was closed.
Counting ticks would drift by however long the machine was busy or asleep.
Counting down to a timestamp is right whenever it happens to run.

Nothing on the tray menu shows the clock. It used to read `Pause (24:57)`,
which meant rebuilding the menu - and so mutating the status item - once a
second, for a number already sitting beside the icon.

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
