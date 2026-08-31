# A media bar

A Spotify-shaped title bar: 64px tall, with navigation arrows, a search field
and an account menu in it, and the playback controls along the bottom of the
window.

```sh
pnpm dev
```

## What is worth looking at

**A bar much taller than the platform's.** At 64px this is more than twice the
28pt macOS would have drawn, which is where `titleBarHeight` earns its keep:
the runtime places the window buttons for the bar the page actually drew.

**Nothing is centred on the bar's middle.** In a bar this tall the platform's
window buttons are not in the middle of it - macOS puts them near the top -
so a row lined up on `height / 2` sits visibly below them. `titleBarMetrics()`
reports `buttonTop` and `buttonHeight` for exactly this: where the buttons
are, rather than where a centred layout would guess.

**`trafficLightPosition: { x: 18 }`** moves them in from the edge to match the
bar's own padding. The optional `y` is left out, so they keep the vertical
placement the platform chose.

**`backgroundColor: "#000000"`** matches the application, so a fast resize
never shows a pale strip down the side before the page has repainted.

**A dropdown that closes on an outside click.** The account menu is drawn by
the page rather than being a platform menu, because it sits inside the bar and
has to line up with it. It listens on the document and checks `contains`,
which is the part that is easy to get wrong.

**One menu button off-macOS.** Windows and Linux hang the application menu
off the window frame, and a hidden title bar is an undecorated window - the
menu is still installed and its accelerators still fire, but there is no frame
left for it to appear in. `MenuBar.tsx` puts a single button in the bar and
hands the whole menu to `menu.popup`, so File, Edit, View, Playback and Help
arrive as a list with their items as submenus. That is Spotify's own layout,
and it is one button of chrome rather than a row of titles.

Only the button is HTML. Everything below it is the platform's menu, so the
predefined items behave as they do everywhere else and the submenus open the
way the platform opens them. `menu.popup` is the API, so the window needs
`permissions.menu`.

Shuffle and Repeat are checkboxes, and a menu is a snapshot of the moment it
was built - so their values come from `App.tsx` and the menu is rebuilt when
they change.

**Own window controls off-macOS.** `insetLeft === 0` means the platform drew
none, so `WindowControls.tsx` supplies them and `MenuBar.tsx` draws the
application menu that a hidden title bar took away.
