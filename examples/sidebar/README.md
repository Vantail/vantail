# Threads - a sidebar-split title bar

The Mail, Notes, Xcode and Linear layout: a sidebar with its own background
running the full height of the window, the platform's window buttons sitting
in the top-left of it, and a separate toolbar over the content beside it.

```sh
pnpm dev
```

## There is no title bar

That is the whole idea. The two columns run the full height of the window and
the "bar" is their top 52 pixels. The divider between them runs through it.

An element spanning the top would put a strip across the sidebar's background,
and the seam is exactly what this layout exists to avoid - it is what makes
the sidebar read as one piece rather than a panel with a lid.

```
+----------------+------------------------------+
| o o o  Threads |  Inbox / Design System       |  <- top 52px of both
+----------------+------------------------------+
| INBOX          |                              |
|   insetLeft?   |   Ines   09:02               |
+----------------+------------------------------+
    sidebar-bg         content-bg
```

## Which column reserves the window buttons

The buttons are at a fixed spot in the top-left of the *window*, so whichever
column is under them has to leave room:

- sidebar open - the **sidebar header** reserves `insetLeft`
- sidebar collapsed - the **toolbar** reserves it instead
- Windows and Linux - neither, because `insetLeft` is `0` and this application
  draws its own controls on the right

That is a decision CSS cannot make on its own, which is why `App.tsx` reads
`titleBarMetrics()` and passes `reservesInset` to whichever column currently
owns it. Only the leading padding changes; the two headers are otherwise the
same, because the reservation follows the buttons rather than belonging to
either column.

A page that only ever needs padding on one fixed element should use the CSS
variables instead - `--vantail-titlebar-inset-left` and its siblings are on
the document before the first paint, no JavaScript and correct before
hydration. Reading the metrics in script is for when *which* element gets the
padding is itself a decision.

Hard-coding 78px would work on this Mac and be wrong on the next one, wrong on
Windows, and wrong the day the platform changes its mind. `insetLeft === 0` is
also the test for whether to draw your own controls - measuring beats checking
the platform's name.

## Two drags in one strip

Inside the title bar band the divider and the window drag both want the
pointer. The divider wins by structure rather than by a coordinate check: it
is a child of the root laid over the column boundary rather than of either
column, so a pointer landing on it never reaches the band.

Neither header wires up dragging. The runtime moves the window from the band a
hidden bar left behind - both headers are inside it - and skips the controls.

## Notes

- `Cmd-\` toggles the sidebar. It is a menu item rather than a key listener so
  it works while focus is on a control, and so it is discoverable. The label
  says "Toggle Sidebar" rather than "Hide": a menu is a snapshot, and one that
  claims a direction it cannot keep up with is worse than one that does not.
- `menu.onClick` returns an unsubscribe. `useEffect(() => menu.onClick(...))`
  returns it as the cleanup.
- The window's `backgroundColor` matches the content column, so a fast resize
  shows no pale gap before the page catches up.
- `buttonTop` and `buttonHeight` are passed through as CSS variables. In a bar
  this tall the window buttons are not centred - macOS puts them near the top -
  so anything meant to line up with them should use those rather than assume
  the middle.
