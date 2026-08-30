# Tabs in the title bar

Chrome's layout, without being a browser: the tab strip *is* the title bar, so
the window's top 44px are tabs rather than a bar with tabs beneath it.

```sh
pnpm dev
```

It is a tabbed notes application. There is no address bar and nothing loads a
URL - tabs are how one window holds several documents, which is what they are
for in Finder, Terminal and most editors.

## What is worth looking at

**The strip is the bar.** `titleBarStyle: "hidden"` lets the page run to the
top edge and `titleBarHeight: 44` tells the runtime how tall the bar is, so the
platform's window buttons are placed for a bar that height instead of the 28pt
one they would otherwise assume. `TabStrip.tsx` pads its leading edge by
`insetLeft` so the first tab starts clear of them.

**Tabs shrink, they do not scroll.** Each is `flex: 1 1 0` with a `max-width`
so they stop growing when there are few, and a `min-width` so they stop
shrinking when there are many. The flex container needs `min-width: 0` or it
refuses to be smaller than its contents and the tabs never get the chance.

**The close button disappears before the label does.** A container query on
the tab hides it under 110px, so a narrow tab spends its remaining room on the
title. The tab stays closable from the menu and Cmd-W.

**Cmd-W closes the tab, not the window.** It is a menu item rather than a key
handler: on macOS the shortcut only exists because a menu item claims it, and
claiming it here is what stops the platform closing the whole window. `Cmd-T`
opens one the same way. `App.tsx` hears both by `id` through `menu.onClick`.

**Where the platform draws no window buttons, this does.** `insetLeft === 0`
is the test - measuring rather than checking the platform's name - and
`WindowControls.tsx` supplies minimise, maximise and close on the trailing
edge. `MenuBar.tsx` draws the application menu for the same reason: a hidden
title bar takes the platform's menu bar with it on Windows and Linux.
