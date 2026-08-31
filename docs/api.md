# API reference

Everything is imported from `@vantail/api`. Everything returns a promise
unless its name ends in `Sync`. Failures reject with a
[`VantailError`](#errors).

```ts
import {
  app,
  appWindow,
  clipboard,
  dialog,
  filesystem,
  menu,
  notification,
  os,
  process,
  shell,
  tray,
  updater,
} from "@vantail/api";
```

`appWindow` is also exported as `window`, which reads better in application
code but shadows the global inside that module. Pick whichever you prefer.
`process` likewise shadows Node's global in a bundler's SSR context - import
it as `import { process as childProcess }` if that bites.

## app

| Method                              | Returns                                                   |
| ----------------------------------- | --------------------------------------------------------- |
| `app.name()`                        | The application name                                      |
| `app.version()`                     | The version string                                        |
| `app.identifier()`                  | The bundle identifier                                     |
| `app.info()`                        | All of the above plus `isDev`                             |
| `app.infoSync()`                    | The same, without awaiting - `undefined` in a browser     |
| `app.isDev()`                       | Whether this is `vantail dev`                             |
| `app.emit(event, payload?, { to })` | Send an event to one window, or all of them               |
| `app.listen(event, handler)`        | Receive those events; returns an unsubscribe function     |
| `app.onSecondInstance(handler)`     | Somebody started the app again; it handed over and exited |
| `app.quit()`                        | Closes the application                                    |
| `app.restart()`                     | Relaunches with the same arguments                        |

`infoSync` works because the runtime injects the app's identity before any
page script runs, so it is safe to read during module evaluation.

### The icon in the dock or taskbar

```ts
await app.setBadge(unread); // null clears it
await app.setProgress({ value: 40, state: "normal" });
await app.setProgress({ state: "none" }); // finished
```

`setProgress` takes `value` from 0 to 100 and a `state` of `none`, `normal`,
`indeterminate`, `paused` or `error`. Linux and macOS treat everything but
`none` as `normal`, and Linux needs a desktop environment with libunity.

`setBadge` shows text on macOS and a number on Linux, so a label that is not a
number is refused there. Windows has no text badge and answers `UNSUPPORTED`.

### No dock icon at all

```ts
// vantail.config.ts
showInDock: false,
```

macOS only. This is the accessory activation policy: no Dock icon, and no
Cmd-Tab entry. What a menu bar application wants, where a Dock icon would be a
second way in that leads nowhere.

It is config rather than a method because AppKit reads the policy once, when
the event loop starts running, and ignores it afterwards. `vantail package`
also writes `LSUIElement` into the bundle, so a packaged build behaves this way
before its first line of JavaScript runs.

Usually set with `quitOnLastWindowClosed: false`, and on Windows and Linux with
`appWindow.setSkipTaskbar(true)`, which is the nearest equivalent.

## Windows

Every window has a **label**. `main` is the one the config opens.

```ts
import { appWindow, createWindow, getWindow, listWindows } from "@vantail/api";

appWindow.setTitle("..."); // this window
const settings = await createWindow("settings", { url: "settings.html" });
await getWindow("settings").focus(); // any window, by label
await listWindows(); // ["main", "settings"]
```

| Function                                | Notes                                           |
| --------------------------------------- | ----------------------------------------------- |
| `createWindow(label, options)`          | Resolves once the new window's page has loaded  |
| `getWindow(label)`                      | A handle. Calls on a window that is gone reject |
| `listWindows()`                         | Labels, in the order the windows were opened    |
| `currentWindow()`                       | This window's label, without awaiting           |
| `onWindowCreated/Ready/Closed(handler)` | Broadcast to every window                       |

`createWindow` waits for the page because a window exists before its document
does - without that, a message sent immediately after would arrive at a
webview with nothing listening yet. Pass `{ waitForReady: false }` to skip it,
or `readyTimeoutMs` to change how long it waits (default 15000).

Its other options are the `window` block from the config - `title`, `width`,
`height`, `resizable`, `alwaysOnTop`, and the rest - plus `url`, a path within
the application such as `settings.html` or `/#/settings`.

Two windows are two webviews with nothing shared between them. `app.emit` and
`app.listen` are how they talk.

### What shows before the page has painted

```ts
window: { backgroundColor: "#14121a" }
```

A web view paints on its own schedule, and during a live resize it runs a frame
or two behind the window. Drag a corner outwards quickly and there is a strip
down the right the page has not reached yet - measured here at up to 64px on a
fast drag - showing whatever is underneath. By default that is a neutral grey,
which reads as a hole torn in the window. Set to the application's own
background it is invisible: the bar simply has not caught up yet, which is much
easier to look at.

It sets the colour on both the window and the web view, because during that gap
it is the window underneath that is on screen - setting only the web view's
changes nothing, which is worth knowing if you go looking.

This does not make the page paint any sooner. Nothing available here does: the
web view's frame follows the window immediately, and what lags is WebKit's own
painting. Growing is where it shows; shrinking tracks within a few pixels.

### Drawing your own title bar

```ts
window: {
  titleBarStyle: "hidden",
  trafficLightPosition: { x: 16, y: 18 },
}
```

No title bar, and the page runs to the top edge of the window - which is what
lets an application put its own back and forward buttons, address bar or tab
strip up there.

On **macOS** the traffic lights stay. They are the system's: an application
that draws its own gets the spacing, the hover behaviour and the full-screen
transition subtly wrong, and users notice. Your content runs underneath them,
so you have to leave room - and the runtime tells you how much rather than
making you guess:

```css
.toolbar {
  height: var(--vantail-titlebar-height);
  padding-left: var(--vantail-titlebar-inset-left);
  padding-right: var(--vantail-titlebar-inset-right);
}
```

Those three are set on `:root` before the page lays out, so a toolbar sized
from them is right on the first frame rather than after a reflow. They are
measured from the window itself - `--vantail-titlebar-height` is the height
of the bar that `hidden` removed, and the insets are the room the system's
buttons occupy.

**Do not hardcode these.** The number everyone copies for macOS is 28; on a
current macOS it measures 32, and it is 0 on a window whose bar is not hidden.
`titleBarMetrics()` returns the same values to JavaScript, synchronously, for
the cases CSS cannot reach - laying out a canvas, or deciding whether to draw
your own window controls (`insetLeft === 0` means the platform is not drawing
any).

### A taller bar

`--vantail-titlebar-height` defaults to the platform's own, which is what makes
a custom bar read as a title bar rather than as a div. For a browser-style
toolbar, ask for more:

```ts
window: { titleBarStyle: "hidden", titleBarHeight: 48 }
```

```ts
await appWindow.setTitleBarHeight(48);   // taller
await appWindow.setTitleBarHeight(null); // the platform's own again
```

On macOS this asks the platform for a taller title bar, and **the height you get
back is the platform's rather than the one you asked for.** That is not a
rounding error, it is the whole point: macOS draws the window buttons and
centres them in the bar it provides, and it keeps them centred while the window
is resized. Size your toolbar from the reported number - the CSS variable
already is - and the lights line up with it, always.

On macOS this also moves the window buttons: they end up centred in the bar you
asked for, instead of sitting near the top where a 28pt title bar left them.
Any height, and the number you ask for is the number you get and the number
reported back.

That is done by growing the `NSTitlebarContainerView` and re-pinning it to the
top of the window, then placing the buttons a margin up from its bottom edge.
It is the same technique Electron's `WindowButtonsProxy` uses, and it is worth
knowing which view: the buttons live in an `NSTitlebarView` *inside* that
container, and growing the inner one sets an origin against a parent barely
thirty points tall - which puts it hundreds of points above the window and
takes the buttons with it. "Resizing the container makes the lights vanish" is
what that looks like from outside.

AppKit undoes it on every relayout, so it has to be put back - and *where* it
is put back decides whether you see it happen. Doing it from the resize event
is a frame late, because AppKit has laid out and drawn by the time the event
arrives, so the buttons visibly jump for the whole of a corner drag.

So the runtime does it while the title bar is being drawn instead. It adds a
view of its own to the title bar container, paints nothing, and corrects the
geometry from that view's `drawRect:` - after AppKit has finished laying out
and before anything reaches the screen. The view never takes a click
(`hitTest:` answers null), so the buttons underneath keep theirs.

tao does the same thing for its own traffic light inset, from the `drawRect:`
of the window's content view. That hook is no use here because the content
view is a `WKWebView`, which is why this has a view of its own.

You do not need `titleBarHeight` to have a tall toolbar. With
`titleBarStyle: "hidden"` the page already runs to the top edge, so a bar is
however many pixels you draw. What this adds is the window buttons being
centred in it rather than left up in the corner.

**To draw the controls yourself, take the buttons.** You then own their size,
colour and hover behaviour - and you own getting them right, which for the
green button means more than it looks:

```ts
window: {
  titleBarStyle: "hidden",
  titleBarHeight: 60,
  titleBarButtons: "hidden",   // and draw your own
}
```

`titleBarMetrics().height` then reports 60, `insetLeft` is 0, and nothing in
the bar is drawn by anyone but you - so nothing constrains it, and there is
nothing to keep in step during a resize either. You do have to draw the three
controls yourself; `examples/react` does, and sizes them from the height so
they scale with it.

`insetLeft` does change with the taller bar: macOS starts its buttons a little
further in there, and the reported inset says so.

Their **size** is not yours to set either - macOS draws them at a fixed 12
points whatever the bar is. If you want bigger ones, take the platform's away
and draw your own:

```ts
window: { titleBarStyle: "hidden", titleBarButtons: "hidden" }
```

```ts
await appWindow.setTitleBarButtons("hidden");  // yours
await appWindow.setTitleBarButtons("system");  // the platform's back
```

With them hidden, `insetLeft` is `0` - the same signal Windows and Linux
already give - so the code that decides *whether* to draw its own controls
needs no new branch. What they look like does: see **Drawing your own** below.
You then own the size, the colour and the hover behaviour, and you own getting
them right.

Their **colour** is not yours to set. macOS draws them red, amber and green
when the window is in front and grey when it is not - and grey in front too if
the user has picked Graphite under Appearance, which is a common reason for
"my traffic lights are the wrong colour". There is no API for it because it is
the user's choice, not the application's.

`trafficLightPosition` moves them somewhere other than where the platform
puts them, and `appWindow.centerTrafficLights()` puts them back:

```ts
window: { trafficLightPosition: { x: 13 } }   // the usual 9, nudged 4 across
```

`y` is optional, and usually best left out: without it they stay centred in
whatever height the bar is, so the nudge still holds after a change of
`titleBarHeight` instead of needing to be worked out again. Give both to place
them outright - `y` is the gap above them, measured from the top of the bar.

Either way the group keeps the spacing macOS chose between the three; only
where it starts is yours.

An explicit position has a ceiling. The container AppKit keeps the buttons in
is only as tall as the bar in force - 28pt ordinarily, 40pt with the taller one
- and cannot be grown by hand: resizing it makes the lights vanish, and letting
them past its bottom edge draws them where AppKit will not hit-test. So a `y`
larger than the container has room for stops there rather than descending
further. Live and a little high beats centred and dead.

The lights are moved by setting their frames rather than through tao's
`set_traffic_light_inset`. That call resizes the title bar container and lets
AppKit re-lay the buttons inside it, and on current macOS the resize does not
stick: read the container back and it measures 32 again, so the lights never
move vertically however the inset is calculated. It is worth knowing if you
are reading the runtime and wondering why the obvious API is not the one being
used.

The frames are also put back on every resize. AppKit re-lays the title bar out
when the window changes size and returns the buttons to where it wants them,
so a moved set of lights would snap home the moment you dragged a corner. The
placement is worked out from where the platform originally put each button
rather than from where it sits now, so running it on every frame of a drag
lands them in the same place as running it once.

Both `titleBarHeight` and `trafficLightPosition` survive a live resize, because
the correction happens during the draw rather than after it - see above.

### Drawing your own

Your own controls, on the platforms that have none, are ordinary elements and
ordinary CSS. What they must not be is one look on three platforms. Each
system draws its window buttons differently enough that borrowing another's
is the tell of a web page in a frame:

| | macOS | Windows | GNOME |
| --- | --- | --- | --- |
| Edge | Leading | Trailing | Trailing |
| Order | Close, minimise, zoom | Minimise, maximise, close | Minimise, maximise, close |
| Shape | 12pt coloured circles | 46pt square, full bar height | 24pt circles on a grey fill |
| Hover | Glyph appears in the dot | Grey, and red on close | The circle darkens |
| Maximised | Unchanged | Restore glyph | Restore glyph |

None of those sizes scale with the title bar - each system keeps them where
they are however tall the bar is - so a control sized as a fraction of the bar
is wrong on a bar of any other height.

The **app icon** is the same kind of question and has a shorter answer:
Windows only. It goes at the head of the caption at 16pt, which is where
every Explorer window has one. macOS gives that corner to the traffic lights,
and GTK took the icon out of its header bars, so drawing one on either is the
same mistake in the other direction.

`os.infoSync()` answers with the platform synchronously, off the same injected
bridge as `titleBarMetrics()`, so the right controls are in the first frame
the window paints. `os.platform()` resolves a tick later, which is long enough
to see the wrong ones swap for the right ones.

```ts
const platform = os.infoSync()?.platform;   // "macos" | "windows" | "linux"
```

Two behaviours are worth copying whichever platform you are on. Colour the
controls while the window is focused and grey them when it is not, which
`appWindow.onFocusChanged` tells you. And swap the maximise control for a
restore one while the window is maximised - `appWindow.isMaximized()`, asked
again on `onResized`, because a snap or a double-click on the bar maximises a
window without going through your button.

[`examples/react`](../examples/react/src/TitleBar.tsx) draws all three, and
its stylesheet keys off a `data-platform` attribute rather than repeating the
branch in the markup.

### Switching at runtime

```ts
const metrics = await appWindow.setTitleBarStyle("hidden");
await appWindow.titleBarStyle(); // "hidden"
```

For a "use the system title bar" preference, or just to show both. The CSS
variables and `titleBarMetrics()` are updated before the call resolves, so a
toolbar sized from either follows the switch instead of keeping numbers that
are no longer true - which is also the easy way to show and hide your own bar:

```css
#titlebar { display: none; }
html[data-titlebar="hidden"] #titlebar {
  display: flex;
  height: var(--vantail-titlebar-height);
  padding-left: var(--vantail-titlebar-inset-left);
}
```

On macOS the switch is seamless. Everywhere else the only lever is the window
frame, so it adds and removes decorations - and switching back restores what
the config asked for rather than assuming a frame, so a window that started
with `decorations: false` does not gain one it never wanted.

The showcase demonstrates the whole arrangement: its **window** panel has
*hide the title bar* and *bring it back*, and the strip that appears at the
top is the app's own, sized entirely from the variables.

On **Windows and Linux** there is no way to keep the buttons without the bar,
so `hidden` is an undecorated window and your toolbar has to include close,
minimise and maximise itself. Both insets are `0` there, which is the signal
to draw them - branch on that rather than on the platform name. What to draw
is the other question, and that one is the platform's: see
[Drawing your own](#drawing-your-own).

`decorations: false` is a different thing and still there: it removes the
frame entirely, traffic lights included.

### Scrolling

A window is a fixed frame, not a page. By default the document does not
scroll, does not rubber-band at its edges, and has no scrollbars. Panes inside
it still scroll - that is what their own `overflow` is for.

```ts
// vantail.config.ts
window: { scroll: true },   // this window really is a page
```

Turn it on for a window that is a document: a long report, a reference, the
kind of thing a browser would scroll. One element can keep its scrollbars
without the rest of the window changing:

```html
<div data-vantail-scrollbar>...</div>
```

The stylesheet is appended to `<html>` before the page's own is parsed, so an
application that disagrees just overrides it.

### Dragging it

A window with no title bar has nothing to drag it by, so **the runtime drags
it for you**. There is nothing to write:

- the band the hidden bar left behind - `titleBarHeight`, or the platform's
  own height if you named none - moves the window;
- a double click there maximises it, the way a real title bar does;
- controls are skipped, so a pointer down on a button, input, link, or
  anything with `role="button"`, `role="tab"`, `role="menuitem"` and their
  neighbours still becomes a click;
- nothing happens at all when the title bar is the platform's own, because
  there is a real bar doing the job.

Two attributes adjust it, and both work anywhere on the page:

| Attribute               | Effect                                                        |
| ----------------------- | ------------------------------------------------------------- |
| `data-vantail-drag`     | This subtree moves the window, even outside the band           |
| `data-vantail-no-drag`  | This subtree does not, even inside it                          |

`data-vantail-drag` is what a two-row chrome needs: `titleBarHeight` covers
the row the window buttons sit in, so a second row below it opts in.
`data-vantail-no-drag` on `<body>` turns the whole thing off.

A control you build out of a `<div>` is not a control as far as any of this is
concerned - give it `role="button"` or `role="tab"`, which you wanted for
screen readers anyway, or mark it `data-vantail-no-drag`. Otherwise the window
moves instead of the thing being clicked.

Calling `preventDefault()` on the `pointerdown` also keeps the runtime out of
the way, which is how you take over a region yourself - see
{@link appWindow.startDragging} for when that is worth doing.

`-webkit-app-region: drag` is a Chromium extension. It does nothing in a
WKWebView, so a CSS property would work on two platforms out of three, which
is worse than not having it - hence an attribute the runtime reads.

## appWindow and window handles

Sizes and positions are in **logical pixels**, so they mean the same thing on
a HiDPI display as on a normal one. Every method below exists on `appWindow`
and on any handle from `getWindow`.

| Method                                                               | Notes                                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `setTitle(title)` / `title()`                                        |                                                                                                       |
| `setSize(width, height)` / `size()`                                  |                                                                                                       |
| `setPosition(x, y)` / `position()`                                   | Outer position, screen coordinates                                                                    |
| `center()`                                                           | On the monitor the window is currently on                                                             |
| `minimize()` / `unminimize()`                                        |                                                                                                       |
| `maximize()` / `unmaximize()` / `toggleMaximize()` / `isMaximized()` | `toggleMaximize` resolves with the new state                                                          |
| `setFullscreen(value)` / `isFullscreen()`                            |                                                                                                       |
| `setResizable(value)` / `setAlwaysOnTop(value)`                      |                                                                                                       |
| `show()` / `hide()` / `focus()`                                      |                                                                                                       |
| `show()` / `hide()` / `isVisible()`                                  |                                                                                                       |
| `setCloseBehavior(behavior)` / `closeBehavior()`                     | `close` (default), `hide` or `ask`                                                                    |
| `close()`                                                            | Resolves `true` if it was open. Closing the last window quits, unless `quitOnLastWindowClosed: false` |
| `exists()`                                                           | Whether that label is still open                                                                      |
| `openDevtools()`                                                     | Where the build allows it                                                                             |

Events return an unsubscribe function:

```ts
const stop = appWindow.onResized(({ width, height }) => {
  console.log(width, height);
});

stop();
```

`onResized`, `onMoved`, `onFocusChanged`, `onCloseRequested`.

A window's events reach only that window, so these fire on `appWindow` and
stay quiet on a handle to somebody else's window.

### Size limits

```ts
await appWindow.setMinSize(400, 300);
await appWindow.setMaxSize(null, null); // remove
```

`setMinSize` and `setMaxSize` take logical pixels, and `null` for both
dimensions removes the limit.

They constrain resizes that go through the window system - a user dragging an
edge, or maximising. They do **not** clamp `setSize`, which asks the platform
directly: setting a 400x300 minimum and then calling `setSize(200, 150)` gives
you a 200x150 window. If you need a floor on your own calls, apply it yourself.

`setSkipTaskbar(value)` keeps a window out of the taskbar on Windows and
Linux. macOS has no taskbar and answers `UNSUPPORTED`.

## filesystem

Every call is checked against `permissions.filesystem` - see
[permissions.md](permissions.md).

| Method                                      | Notes                                                          |
| ------------------------------------------- | -------------------------------------------------------------- |
| `readText(path)`                            |                                                                |
| `writeText(path, contents, { createDirs })` | `createDirs` defaults to `false`, so a typo fails loudly       |
| `appendText(path, contents)`                | Creates the file if missing                                    |
| `readDir(path)`                             | `DirEntry[]`, directories first, then case-insensitive by name |
| `exists(path)`                              | Needs read permission - existence is information               |
| `stat(path)`                                | Size, timestamps, and the three `is*` flags                    |
| `mkdir(path, { recursive })`                |                                                                |
| `remove(path, { recursive })`               | Never follows a symlink: removes the link                      |
| `copy(from, to)`                            | Read on `from`, write on `to`                                  |
| `rename(from, to)`                          | Write on both                                                  |
| `readBinary(path)`                          | Resolves to a `Uint8Array`                                     |
| `writeBinary(path, data, { createDirs })`   | Takes `Uint8Array`, `ArrayBuffer` or any view                  |

Binary data crosses the IPC boundary as base64 inside a JSON string, which
costs a third again in size and has to be built in memory on both sides. That
is fine for icons, documents and small media, and wrong for video - so there
is a 64 MB limit, and exceeding it is an error that says so.

```ts
interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

interface FileInfo {
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  readonly: boolean;
  modifiedAt: number | null; // milliseconds since the epoch
  createdAt: number | null;
}
```

### Watching for changes

```ts
const { id } = await filesystem.watch(dir, { recursive: true });
const stop = filesystem.onChange(({ kind, path }) => reload(path));
// later
stop();
await filesystem.unwatch(id);
```

| Method                       | Notes                                    |
| ---------------------------- | ---------------------------------------- |
| `watch(path, { recursive })` | Returns `{ id, path, recursive }`        |
| `unwatch(id)`                | `NOT_FOUND` if it is not running         |
| `watches()`                  | The ids currently running                |
| `onChange(handler)`          | Every watch reports here; filter on `id` |

A change is `{ id, kind, path, watching }`, where `kind` is `created`,
`modified`, `removed` or `renamed`.

A watch is scoped exactly like a read - watching a path you cannot read is
denied - and it is a compile-time feature, on by default.

Two things are platform-dependent and worth coding against rather than around.
**A single change can report more than one event**: writing a file often gives
both `created` and `modified`. And **watching a directory that was just created
replays its own creation first**, so a handler that acts on the first event it
sees may act on the wrong one. React to the path, not to the arrival.

## fileDrop

```ts
fileDrop.onDrop(async ({ paths }) => {
  for (const path of paths) console.log(await filesystem.readText(path));
});
```

| Method             | Fires                                                          |
| ------------------ | -------------------------------------------------------------- |
| `onEnter(handler)` | A drag arrives over the window, carrying `{ paths, position }` |
| `onDrop(handler)`  | It is let go                                                   |
| `onLeave(handler)` | It leaves, or is cancelled                                     |

Each returns an unsubscribe function. `position` is relative to the window's
top-left corner.

HTML5 drag events give a page the _contents_ of a dropped file but never its
path, so a dropped file cannot be handed to `filesystem`. These carry the
paths, and a dropped path becomes readable for the rest of the session -
dropping a file is the user choosing it, exactly as a dialog is.
`filesystem.grantFromDrop` controls that and is on by default. Read only:
dropping something says look at this, not overwrite it.

Needs `permissions.dragDrop`. **Turning it on changes what the page sees.**
The runtime then handles the drop, so HTML5 `drop` events stop firing for
files and these arrive instead. With the permission off nothing changes, and
WebKit behaves exactly as it did.

## dialog

Every picker resolves to `null` when the user cancels. A path the user picks
is granted to `filesystem` for the rest of the session.

```ts
const path = await dialog.openFile({
  title: "Open a document",
  defaultPath: await os.homeDir(),
  filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
});
```

`openFile`, `openFiles`, `openDirectory`, `openDirectories`, `saveFile`.

`saveFile` also takes `defaultName` for the pre-filled file name.

On macOS an alert renders as an app-modal panel that the accessibility API
cannot see, so `message` and `confirm` are the two calls this project cannot
drive from a test. They are checked by looking at the screen.

```ts
await dialog.message("Saved.", { title: "Done", kind: "info" });

const proceed = await dialog.confirm("Discard changes?", {
  kind: "warning",
  okLabel: "Discard",
  cancelLabel: "Keep editing",
});
```

## clipboard

```ts
await clipboard.writeText("hello");
const text = await clipboard.readText();

const image = await clipboard.readImage();
if (image) {
  img.src = URL.createObjectURL(new Blob([image.data], { type: "image/png" }));
}
```

| Method            | Notes                                             |
| ----------------- | ------------------------------------------------- |
| `readText()`      | `""` when the clipboard holds no text             |
| `writeText(text)` |                                                   |
| `hasText()`       |                                                   |
| `readImage()`     | `{ width, height, data }` as PNG bytes, or `null` |
| `writeImage(png)` | Takes PNG bytes                                   |
| `hasImage()`      |                                                   |
| `clear()`         | Removes text and images alike                     |

Reading and writing are separate permissions: `clipboard: { read, write }`.

On Linux the clipboard needs X11 or XWayland. Under Wayland with neither, it
answers `UNSUPPORTED` rather than hanging - worth handling if you target
minimal Wayland sessions.

Images cross as PNG rather than raw pixels, since that is what goes straight
into an `<img>`, a `Blob`, or a file. The clipboard itself holds RGBA, so the
conversion happens in the runtime - a PNG without an alpha channel is fine to
write.

## os

`platform()`, `arch()`, `info()`, `infoSync()`, `homeDir()`, `tempDir()`,
`appDataDir()`, `appConfigDir()`, `resourceDir()`.

`platform()` returns `"macos" | "windows" | "linux"`. The app directories are
named after `app.identifier`.

`resourceDir()` is where the built assets are: the bundle's resource directory
once packaged, and Vite's `publicDir` under `vantail dev`, so a file named the
same way is found in both. It is also what a relative tray icon path and
`$RESOURCE/...` in `permissions.shell` resolve against.

## path

```ts
import { os, path } from "@vantail/api";

const file = path.join(await os.appDataDir(), "projects", "notes.md");
path.dirname(file); // ".../projects"
path.basename(file); // "notes.md"
path.basename(file, ".md"); // "notes"
path.extname(file); // ".md"
path.isAbsolute(file); // true
path.normalize("a/b/../c"); // "a/c"
path.sep; // "/" or "\\"
```

A webview has no `path` module, and asking the runtime for every join would
put an IPC round trip inside every directory walk - so every application that
touches more than one file ends up writing this, and getting the Windows
separator subtly wrong. It is string work only: nothing here touches the
filesystem, so nothing here needs a permission. `path.join` will happily build
a path the application is not allowed to read, and `filesystem` is what
refuses it.

`path` follows the platform. `path.posix` and `path.win32` are both available
whichever platform that is, for handling a path that came from somewhere else.
The semantics match Node's `path`, which is what the test suite checks them
against.

There is no `resolve`: a webview has no current working directory to resolve
against. Start from `os.appDataDir()`, `os.homeDir()`, or a path the user
picked in a dialog - which is also the only kind `filesystem` will accept.

## notification

```ts
await notification.show("Export finished");
await notification.show({ title: "Export", body: "Finished", icon: "..." });
```

On macOS notifications are delivered through the bundle identifier, so an
unbundled `vantail dev` run reports `UNSUPPORTED`. Try `vantail package`.

## menu

```ts
await menu.set([
  {
    type: "submenu",
    label: "File",
    items: [
      { id: "open", label: "Open...", accelerator: "CmdOrCtrl+O" },
      { type: "separator" },
      { type: "checkbox", id: "wrap", label: "Wrap lines", checked: true },
      { type: "predefined", item: "quit" },
    ],
  },
]);

menu.onClick(({ id }) => {
  /* ... */
});
```

| Function                                          | Notes                                              |
| ------------------------------------------------- | -------------------------------------------------- |
| `set(items)`                                      | Replaces the application menu; returns `{ skipped }` |
| `remove()`                                        |                                                    |
| `popup(items, { x, y, label })`                   | Context menu; the cursor when no position is given |
| `setEnabled(id, enabled)` / `setLabel(id, label)` | Submenus are addressed by their label              |
| `setChecked(id, checked)` / `isChecked(id)`       | Checkbox items only                                |
| `onClick(handler)`                                | Fires for any item with an `id`, in any menu       |

Setting no menu at all is not the same as setting an empty one. On macOS a
missing `menu` in the config installs the standard application menu, so Cmd-W,
Cmd-Q and the Edit shortcuts work; `menu: []` means no menu on purpose.

Item types are `normal` (the default), `checkbox`, `submenu`, `separator` and
`predefined`.

Predefined items are `separator`, `copy`, `cut`, `paste`, `selectAll`, `undo`,
`redo`, `minimize`, `maximize`, `fullscreen`, `hide`, `hideOthers`, `showAll`,
`closeWindow`, `quit`, `about`, `services` and `bringAllToFront`. **On macOS
these are load-bearing**: without `copy`, `paste`, `undo` and `selectAll` in
the menu, their keyboard shortcuts do not work anywhere in the app.

Accelerators are strings like `CmdOrCtrl+S`, `Alt+Shift+F4`,
`CmdOrCtrl+ArrowUp`. Modifiers come first and the key comes last. `Return` is
accepted as a name for `Enter`, because that is what an Apple keyboard has
printed on it.

An accelerator the platform cannot parse is checked in three places:

1. **At config load.** `vantail dev`, `vantail build` and `vantail doctor` all
   validate the accelerators in `vantail.config.ts` against the same key names
   the runtime accepts, so a typo is a config error before a window exists.
2. **At install.** The item that could not be built is left out and named on
   stderr; the rest of the menu is installed. `menu.set` and `tray.setMenu`
   return `{ skipped }` saying which items went missing.
3. **Never by losing the menu.** On macOS a menu that fails to install takes
   Cmd-C, Cmd-V, Cmd-Q and Cmd-W with it, since those shortcuts exist only as
   menu items. One mistyped accelerator must not cost an application its
   ability to quit.

### A hidden title bar takes the menu with it

macOS keeps its menu bar at the top of the screen, where `titleBarStyle:
"hidden"` cannot reach it. Windows and Linux hang the menu off the window
frame, and `hidden` is an undecorated window - so the menu is installed, its
accelerators still fire, and there is nowhere left for it to appear. Nothing
reports an error, because nothing failed.

An application that hides its title bar on those platforms has to draw the
menu itself. Draw only the titles, and open the platform's own menu under
whichever was clicked:

```ts
const box = event.currentTarget.getBoundingClientRect();
await menu.popup(submenu.items, { x: box.left, y: box.bottom });
```

`popup` is what keeps that honest. The items in it are the platform's, so the
predefined ones behave; it is a real window rather than a div clipped by this
one; and its clicks arrive through the same `onClick` as the installed menu's,
so nothing downstream has to know which menu was used. It is modal, so the
promise resolves when the menu closes - enough to keep a title highlighted for
exactly as long as its menu is up.

Two things to know before copying it. `popup` builds a **fresh** menu every
time, so anything stateful - a `checkbox`, an `enabled` - has to be built from
your own state rather than written as a literal, or it resets every time the
menu opens. And the array you pop up wants to be the array the config
installed, from one place: two copies is how the menu people click and the
accelerators they press drift apart.

[`examples/react`](../examples/react/src/MenuBar.tsx) does both, and puts the
bar either in the title bar or on a row of its own underneath.

## tray

```ts
await tray.set({
  icon: "tray-icon.png",
  tooltip: "My App",
  iconAsTemplate: true,
  menu: [
    { id: "open", label: "Open" },
    { type: "predefined", item: "quit" },
  ],
});
```

`icon` is a PNG path, relative to the application's resources unless absolute

- and an absolute one has to be inside the filesystem read scope, so this is
  not a way to read a file the app is otherwise not allowed to touch.

Put it in `public/`, which is where a bundler copies static files from and
where `vantail dev` resolves resource-relative paths. So `icon: "tray.png"`
means `public/tray.png` while developing and the copy inside the bundle once
packaged, and there is nothing to change between them.

`iconAsTemplate` renders it monochrome so macOS can invert it against a dark
menu bar. Usually what you want.

`set`, `remove`, `exists`, `setIcon`, `setTooltip`, `setTitle` (macOS),
`setVisible`, `setMenu`, `showMenu`, `onClick`, `onDoubleClick` (Windows).

`leftClick` decides what clicking the icon does:

| Value                  | Behaviour                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `showWindow` (default) | Bring the window back if hidden, focus it if behind something, open the menu if it is already in front |
| `menu`                 | Always open the menu                                                                                   |
| `event`                | Only fire `onClick`, and leave it to you                                                               |

A right click always opens the menu. `window` names which window
`showWindow` targets; `main` by default.

`onClick` fires once per click, on the release, and reports where the icon is:

```ts
tray.onClick(({ x, y }) => { /* x and y are PHYSICAL pixels */ });
```

Those coordinates are in **physical** pixels, while `appWindow.setPosition`
takes **logical** ones - a factor of two on a Retina display. `screen.list()`
reports each display's logical geometry next to its `scaleFactor`, which is
what converts between them. See [examples/tray](../examples/tray).

Read the position from every click rather than remembering it: the icon moves
as other applications add and remove their own.

An app that keeps running with no window open also wants
`quitOnLastWindowClosed: false` in its config, and on macOS
`showInDock: false`.

## process

Only programs named in `permissions.shell.allow`, and only with the arguments
that rule permits. There is no shell involved at any point.

```ts
const { code, stdout, stderr } = await process.execute("git", ["status"], {
  cwd: "/repo",
  timeoutMs: 30_000,
});

const build = await process.spawn("npm", ["run", "build"]);
build.onStdout((chunk) => append(chunk));
build.onExit(({ code }) => done(code));
await build.write("y\n");
await build.kill();
```

`execute` options: `cwd`, `env`, `clearEnv`, `stdin`, `timeoutMs`.
`spawn` takes the first three and resolves to a `Child`.

A `Child` carries an `id` - a handle Vantail allocates, not the OS pid, because
a pid can be recycled the instant a process exits and a stale one must not be
able to signal somebody else's process. The real `pid` is there too, for
display.

`onStdout` and `onStderr` deliver **chunks, not lines**: a program drawing a
progress bar with `\r` never emits a newline, and buffering for one would make
it look hung. Split on newlines yourself if that is what you want.

Children are killed when the runtime exits. A child outliving the app that
launched it is a surprise nobody wants.

## network

```ts
const { status, body } = await network.request({
  url: "http://192.168.1.7/api",
});
const { body: parsed } = await network.json<Lights>({ url });
const { body: bytes } = await network.binary({ url });

// Delivered as it arrives, rather than when it is finished.
const stream = await network.stream({ url: `${base}/events` });
const socket = await network.socket({ url: "wss://api.example.com/live" });
```

An HTTP client in the runtime rather than the webview. **Use `fetch` for the
internet**; this is for what `fetch` refuses: a self-signed certificate, or a
device that sends no CORS headers. An application whose job is to reach
whatever host its user types wants either `allow: ["*"]` or
`grantFromPrompt: true`, which asks the user about a host it has not been
given - see
[permissions](./permissions.md#when-the-host-is-not-known-until-run-time).

| Option         | Notes                                                             |
| -------------- | ----------------------------------------------------------------- |
| `url`          | Absolute. Checked against `permissions.network`                   |
| `method`       | Default `GET`. Any method the server understands                  |
| `headers`      | Sent verbatim. A newline in a value is an error, not an injection |
| `body`         | Sent as UTF-8                                                     |
| `bytes`        | Sent as raw bytes. Wins over `body`                               |
| `timeoutMs`    | Default 30000                                                     |
| `maxRedirects` | Default 5. Every hop is permission-checked                        |
| `signal`       | An `AbortSignal`, the way `fetch` takes one                       |

The response carries:

| Field         | Notes                                                              |
| ------------- | ------------------------------------------------------------------ |
| `url`         | Where it ended up, after redirects                                 |
| `status`      | `statusText` and `ok` beside it; `ok` is 2xx                       |
| `headers`     | Lower-cased names, repeats joined by `, `                          |
| `headerPairs` | Every header line in order, repeats intact                         |
| `body`        | Text, parsed JSON or bytes, depending which call you made          |
| `bodyBytes`   | The body's size in bytes, after any content decoding               |
| `redirects`   | Every hop followed, with the credentials each one dropped          |
| `timing`      | `ttfbMs`, `headMs`, `downloadMs`, `totalMs`                        |

A non-2xx status is an answer, not an exception - only a transport failure
rejects.

**A response is buffered whole, and is capped at 64 MB.** It crosses to the
webview as base64 inside JSON, so there has to be a ceiling; a body one byte
over it is an error rather than a truncation.

### Repeated headers

`headers` is the convenient form and right nearly always. It cannot represent
`set-cookie`, which is the one header that is legitimately repeated *and* the
one where joining is ambiguous, because an `Expires` date contains a comma and
a space of its own. Splitting the joined string back apart is guesswork. Use
`headerPairs`:

```ts
const cookies = response.headerPairs
  .filter(([name]) => name === "set-cookie")
  .map(([, value]) => value);
```

### Bytes, and why `binary` is the better default

`network.request` decodes the body as UTF-8 and replaces anything that is not
valid UTF-8 with U+FFFD rather than failing, so a response that is not text
comes back quietly damaged. `network.binary` hands you the bytes as they
arrived. `bodyBytes` is the exact size either way - `body.length` on a string
counts UTF-16 code units, which is not the same number for anything outside
ASCII.

### Timing

```ts
const { timing } = await network.request({ url });
// { ttfbMs, headMs, downloadMs, totalMs }
```

`ttfbMs` is the first byte of the final response measured from the start of
the call, so DNS, connecting, TLS and any redirects are all inside it.
`headMs` is the final request on its own. There is deliberately no separate
`dnsMs`, `connectMs` or `tlsMs`: the HTTP client the runtime uses does not
expose them, and inventing numbers that look precise would be worse than
leaving them out.

### Cancelling

```ts
const controller = new AbortController();
stopButton.onclick = () => controller.abort();

await network.request({ url, signal: controller.signal });
```

Aborting rejects the call at once with a `CANCELLED` `VantailError`. It does
not interrupt the request already on the wire - the runtime cannot break into
a socket read in progress - so the connection is dropped when it next comes up
for air, or when `timeoutMs` expires. For a stop button that is exactly right:
the application is free immediately. It does mean a burst of cancelled
requests to a host that never answers keeps the runtime's network queue busy
until they time out, so keep `timeoutMs` sane if that is a shape your
application has.

### Streaming

```ts
const stream = await network.stream({
  url: `${base}/events`,
  headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
});

stream.onChunk((text) => { /* ... */ });
stream.onEnd(({ cancelled, error }) => { /* ... */ });
stream.cancel();
```

`network.request` waits for the whole body, which for a stream that stays open
is forever - so server-sent events and long-polling cannot be consumed through
it at all. `network.stream` answers with the head as soon as it arrives, then
delivers the body in chunks as events.

The webview's own `EventSource` works and is the right tool when the server
sets CORS headers. This is for when it does not, and for when the request needs
headers `EventSource` cannot set - which is how most APIs authenticate one.

`network.stream` decodes chunks as UTF-8, holding back any character split
across a chunk boundary and joining it to the next, so a stream of JSON stays
parseable. `network.streamBinary` gives `Uint8Array` chunks instead, which is
also how to download something larger than the 64 MB a buffered response is
capped at, without ever holding the whole thing in memory.

The value `network.stream` resolves to carries the same `url`, `status`,
`headers`, `headerPairs` and `redirects` a buffered response does, and a
`timing` with the two figures known before the body: `ttfbMs` and `headMs`.

Chunks that arrive before the first `onChunk` handler is attached are held and
delivered to it, so awaiting something between opening a stream and listening
to it does not lose the beginning. Nothing is dropped, which means nothing is
bounded either - attach promptly, and `cancel()` a stream you are done with.

`signal` works across both phases: before the head arrives it abandons the
request, afterwards it cancels the stream. There is one caveat, the same one
as for a buffered request: the runtime notices a cancellation between chunks,
so a stream from a host that has gone quiet holds its connection until the
next chunk or the timeout.

### WebSocket

```ts
const socket = await network.socket({
  url: "wss://api.example.com/live",
  headers: { authorization: `Bearer ${token}` },
  protocols: ["graphql-transport-ws"],
});

socket.onMessage((data) => {
  // `string` for a text message, `Uint8Array` for a binary one.
  if (typeof data === "string") handle(JSON.parse(data));
});
socket.onClose(({ code, reason, error }) => { if (error) reconnect(); });

await socket.send(JSON.stringify({ type: "subscribe", topic }));
await socket.sendBytes(bytes);
await socket.close(1000, "done");
```

The webview has its own `WebSocket` and it is the right tool when it can do
the job. It cannot set a header on the opening handshake - the browser API
takes a URL and a subprotocol list and nothing else - so a bearer token has to
go in the query string, where it ends up in the server's logs. This can set
headers, and is not subject to the page's origin rules.

`socket.protocol` is the subprotocol the server chose, which is not
necessarily the first one offered. Pings are answered by the runtime, so a
socket stays up without the application doing anything.

Messages that arrive before the first `onMessage` handler is attached are held
and delivered to it, the same as a stream's chunks. `signal` abandons the
handshake before it completes and closes the socket after.

One socket is one thread, and a `tungstenite::WebSocket` is not full duplex
even though the protocol is - so reads and writes take turns. The read waits
at most 10ms before the loop looks at the outgoing queue, which is what bounds
send latency. It is far below anything a person notices, but it is not zero,
and a socket carrying a game's input would feel it.

**Permissions.** `ws` and `wss` are `http` and `https`: an origin rule like
`http://192.168.1.50:9123` covers `ws://192.168.1.50:9123`, and
`https://api.example.com` covers `wss://api.example.com`. The handshake is an
HTTP GET on that port to that server, so making them separate rules would be a
distinction with no security in it. A bare host rule covers every scheme, as
it always did.

### Client certificates and proxies

Both are permissions rather than call options, so they live in
`vantail.config.ts` where a reviewer sees them - see
[permissions](./permissions.md#clientcertificates). Nothing changes at the
call site: a request to a host the config gave a certificate for presents it,
and a request to a host the config proxies goes through the proxy. Each
redirect hop is matched on its own, so a redirect to another host gets that
host's certificate and proxy rather than the first hop's.

### Redirects

Every hop is permission-checked, and `Authorization`, `Cookie` and
`Proxy-Authorization` are dropped when a hop crosses to another host, the way
a browser drops them. `redirects` is the record of what happened:

```ts
for (const hop of response.redirects) {
  console.log(hop.status, hop.url, "->", hop.location, hop.droppedHeaders);
}
```

Which answers both of the questions that otherwise cannot be answered from
outside: why a `POST` became a `GET`, and which hop ate the auth header.

## database

```ts
import { database, os, path } from "@vantail/api";

const db = await database.open({
  path: path.join(await os.appDataDir(), "ledger.sqlite"),
});

await db.execute("create table if not exists entry(id integer primary key, minor integer not null)");
const rows = await db.query("select id, minor from entry where minor > ?", [0]);

await db.transaction(async (tx) => {
  await tx.execute("update account set minor = minor - ? where id = ?", [amount, from]);
  await tx.execute("update account set minor = minor + ? where id = ?", [amount, to]);
});
```

SQLite, in the runtime. A webview can run SQLite compiled to WebAssembly and
applications do; what it cannot do is give the database anywhere real to live.
Persisting it means writing the whole file out on every commit - fine for a few
megabytes, and not a database - and keeping it in the origin's private storage
instead means the user cannot find, copy or back up their own data. This is the
same file, written by SQLite itself.

| Function                       | Notes                                                    |
| ------------------------------ | -------------------------------------------------------- |
| `open({ path, readOnly })`     | Path goes through `filesystem` scope                     |
| `query(sql, params, options)`  | Rows back                                                |
| `execute(sql, params, options)`| `{ changes, lastInsertRowId }`                           |
| `transaction(run)`             | Commits when `run` resolves, rolls back when it throws   |
| `checkpoint()`                 | Folds the write-ahead log back into the file             |
| `snapshot(path)`               | A consistent copy, via SQLite's own backup API           |
| `close()`                      |                                                          |

Connections open with WAL journalling, `synchronous = NORMAL`, and
`foreign_keys = ON` - SQLite leaves that last one off for compatibility with
2005, so a declared foreign key is otherwise decoration.

### Durability

Connections open with `journal_mode = WAL` and `synchronous = NORMAL`. That
pair cannot corrupt the database - a crash or a power cut leaves it
consistent - but `NORMAL` does not wait for the disk on every commit, so the
last few committed transactions can be lost to a power cut or an OS crash. It
is the right default for an application whose data is recoverable or
re-derivable, and it is much faster.

If losing a committed transaction is not acceptable - a ledger, anything
holding money or a legal record - say so once, after opening:

```ts
await db.execute("pragma synchronous = FULL");
```

`FULL` waits for the write to reach the disk before a commit returns. It costs
a real amount of write throughput, which is why it is not the default, and it
is the difference between "cannot corrupt" and "cannot lose".

Any pragma works this way: the runtime sets sensible defaults at open and does
not stand between the application and SQLite afterwards.

### Integers, and the money bug

SQLite's INTEGER is 64-bit. A JavaScript number is a double, so anything past
2^53 loses its low bits - and for a balance in minor units, those bits are
money. The rule here is that a wrong number is never returned quietly:

```ts
// Refused: `minor` is 9007199254740993, which a number cannot hold exactly.
await db.query("select minor from entry");

// Exact, as a BigInt.
await db.query("select minor from entry", [], { bigint: true });
```

Ask for `bigint` and every integer comes back as one. Do not, and an integer
that does not fit is an `INVALID_PARAMS` error naming the column, rather than a
rounded answer. Small integers stay ordinary numbers either way, so `count(*)`
does not become a BigInt unless you asked.

Pass a `bigint` in as a parameter and it is stored exactly. `Uint8Array`
parameters and BLOB columns work too; a TEXT column holding bytes that are not
UTF-8 comes back as a `Uint8Array` rather than as replacement characters.

### Transactions

SQLite has one write transaction per connection, and so does this. Callers that
overlap wait their turn rather than joining an open `BEGIN` - sharing one means
a rollback in either discards the other's writes.

The transaction begins as `BEGIN IMMEDIATE`, so it takes the write lock at the
start rather than discovering at the first write that somebody else has it.

Do only database work inside the callback. It holds the connection for as long
as it runs, and the statements arrive one IPC round trip at a time - so a
transaction left idle for 30 seconds is rolled back rather than wedging the
connection for the life of the process. A statement naming a transaction that
has ended says so.

### Backing up

```ts
await db.checkpoint();
await db.snapshot(await dialog.saveFile({ defaultName: "ledger-backup.sqlite" }));
```

`snapshot` is SQLite's online backup API, not a file copy: it is safe while the
database is being written to, and the result is a database that opens on its
own. `checkpoint` folds the write-ahead log back in, which is worth doing if
you are going to copy the file by hand instead.

### Encryption

```ts
if (!(await secrets.has("ledger-key"))) {
  await database.createKey("ledger-key");
}
const db = await database.open({ path, keySecret: "ledger-key" });
```

The file on disk is SQLCipher-encrypted: it does not begin with
`SQLite format 3`, and nothing in it is readable without the key.

**The key never crosses into JavaScript.** `createKey` generates it in the
runtime and writes it straight to the OS credential store; `keySecret` names
that entry and the runtime reads it back itself. So a page that has been taken
over can ask for the database it was already allowed to open - and still
cannot read the key out to take the file somewhere else. Passing a key from
your own code is deliberately not offered, because the moment it exists in the
webview it exists in a heap snapshot.

`createKey` refuses a name that already holds a key. Overwriting one makes
every database it opened permanently unreadable, so removing it first has to
be something you did on purpose.

A wrong key is a `PERMISSION_DENIED` at `open`, not a confusing failure inside
your first query - the runtime reads the schema once to check before handing
the connection back.

Needs `permissions.secrets` alongside `permissions.database`: `database` says
this application may keep a database, not that it may help itself to the
credential store.

**It needs the other runtime build.** Say so in the config:

```ts
permissions: { database: { encryption: true }, secrets: true }
```

That is what makes `vantail dev` and `vantail package` resolve
`@vantail/runtime-<platform>-<arch>-sqlcipher` instead of the ordinary one.
They are separate packages because SQLCipher carries its own crypto - the
encrypted build measures about 3 MB more - and both are optional dependencies
with `os` and `cpu` set, so an application that does not encrypt anything never
downloads it. See [packaging](./packaging.md#two-runtime-builds).

A runtime asked for encryption it was not built with refuses at startup, naming
the package to install, rather than opening the file in the clear. The
dangerous outcome would be a working database that is not encrypted and gives
no sign of it.

### What is not here

No migrations. They are a few lines of `user_version` and `execute` in your
own code, and a framework's opinion about them would be worth less than
yours.

## mdns

```ts
const bridges = await mdns.discover({
  service: "_hub._tcp.local",
  timeoutMs: 3000,
});
// [{ service, name, fullname, host, port, addresses, txt }]
```

Finding devices on the local network. No browser can hear multicast DNS, and
the alternative is asking your user to type in an IP address.

| Function                           | Notes                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `discover({ service, timeoutMs })` | Listens for a fixed period, then returns everything that answered. Default 3000, capped at 60000 |
| `browse(service)`                  | Keeps watching. `{ started: false }` if already watching that type                               |
| `stop(service)`                    | `false` if it was not being watched                                                              |
| `browsing()`                       | Service types currently watched                                                                  |
| `onFound` / `onLost`               | Devices appearing and disappearing                                                               |

Service types look like `_hub._tcp.local`; the trailing dot is optional.
Passing a hostname is `INVALID_PARAMS` rather than an empty result, because
that is the mistake worth catching.

`discover` resolves when the time is up, not when the first device replies -
devices answer at their own pace.

## hid

```ts
const [deck] = await hid.list();
const connection = await hid.open(deck.id);

connection.onInput((report) => decodeButtons(report));
await connection.write(new Uint8Array([0x02, 0x0b, 0x01]));
```

WebHID does not exist in these webviews, so a control pad, a foot pedal or a
macro pad is otherwise unreachable.

| Function   | Notes                                     |
| ---------- | ----------------------------------------- |
| `list()`   | **Only devices `permissions.hid` allows** |
| `open(id)` | Resolves to a connection                  |
| `opened()` | Everything this application has open      |

A connection has `write`, `sendFeatureReport`, `getFeatureReport(reportId,
length)`, `close`, `onInput` and `onClosed`.

**The first byte of a report is the report id** - `0` for devices that do not
use numbered reports. `getFeatureReport`'s `length` excludes it. Input reports
arrive with it included.

`onClosed` fires whether you closed the device or it was unplugged; `reason`
tells you which.

## screen

```ts
const { position, size } = await screen.current();
await appWindow.setPosition(
  position.x + (size.width - 900) / 2,
  position.y + (size.height - 640) / 2,
);
```

A page can see the screen it is on through `window.screen`, but not the others
and not where they sit relative to each other - so `setPosition` is guesswork
on a machine with two monitors without this.

| Method            | Returns                                          |
| ----------------- | ------------------------------------------------ |
| `list()`          | Every connected display                          |
| `primary()`       | The one the system considers primary, or `null`  |
| `current()`       | The display this window is on, or `null`         |
| `fromPoint(x, y)` | Whichever display contains that point, or `null` |

Each is `{ name, position: { x, y }, size: { width, height }, scaleFactor,
primary }`.

**Everything is in logical pixels**, the units the window methods take. A
screen left of the primary one has a negative `x`. `scaleFactor` is 2 on a
Retina display, and a display in a scaled mode reports the size the user sees
rather than the panel's - a 3456x2234 panel set to look like 2056x1329 reports
2056x1329. Covered by `permissions.window`, which is on by default.

`tray.onClick` is the exception in this API: it reports **physical** pixels,
because that is what the platform hands over. Divide by the `scaleFactor` of
the display the point falls on before passing it to `setPosition`.

## shortcut

```ts
await shortcut.register("CmdOrCtrl+Shift+K", { id: "toggle" });
shortcut.onPressed(({ id }) => {
  if (id === "toggle") void appWindow.show();
});
```

Key combinations that fire while your application is in the background. A page
only sees keys while it has focus, which is the opposite of what this is for.

| Method                          | Notes                                                             |
| ------------------------------- | ----------------------------------------------------------------- |
| `register(accelerator, { id })` | `id` defaults to the accelerator. Spelled like a menu accelerator |
| `unregister(accelerator)`       | `NOT_FOUND` if this application does not hold it                  |
| `unregisterAll()`               |                                                                   |
| `isRegistered(accelerator)`     | Whether _this_ application holds it                               |
| `list()`                        | `{ id, accelerator }` for each                                    |
| `onPressed(handler)`            | Returns an unsubscribe function                                   |

Registration is system-wide, so it fails with `ALREADY_EXISTS` when another
application already owns the combination. That is worth handling: it is a
normal thing to happen, and there is nothing you can do about the other
application. Needs `permissions.shortcut`.

## autostart

```ts
if (!(await autostart.isEnabled())) await autostart.enable();
```

| Method        | Notes                          |
| ------------- | ------------------------------ |
| `enable()`    |                                |
| `disable()`   | Doing it twice is not an error |
| `isEnabled()` |                                |

Written where each platform keeps its own register: a launch agent in
`~/Library/LaunchAgents` on macOS, a value under the `Run` key on Windows, a
desktop entry in `~/.config/autostart` on Linux. macOS launches the bundle
through `open` rather than the executable inside it, since running that
directly gives a process with no icon and no menu bar.

All three record a path, so this needs a packaged application. An unpackaged
build answers `UNSUPPORTED` rather than recording a path that will not survive
the session. Needs `permissions.autostart`.

## power

```ts
power.onSuspend(() => bot.disconnect());
power.onResume(() => bot.connect());
```

| Method               | Notes                                                |
| -------------------- | ---------------------------------------------------- |
| `onSuspend(handler)` | The machine is about to sleep. Very little time here |
| `onResume(handler)`  | It woke up                                           |
| `supported()`        | Whether this platform reports either                 |

A page cannot notice a machine sleeping. There is no browser API for it, and
nothing executes while it is asleep, so a timer cannot tell either - all it can
observe afterwards is that time jumped. What this is for is a connection that
will not survive a lid closing: drop it on the way down and open it again on
the way back, rather than waiting for a socket to work out it is dead.

**macOS only for now.** Elsewhere the events never fire rather than firing at
the wrong moment, and `supported()` returns `false` so an application can keep
its own reconnect timer where it has to.

## secrets

```ts
await secrets.set("service.refreshToken", token);
const token = await secrets.get("service.refreshToken");
```

The macOS Keychain, the Windows Credential Manager, or the Secret Service on
Linux. Entries are filed under the application's `identifier`, so two Vantail
applications cannot read each other's.

`set`, `get`, `has`, `delete`. A missing secret reads back as `null` rather
than throwing - an application asking "am I signed in?" should not have to
catch an exception. `delete` answers `false` if there was nothing there.

There is no `list()`: the platforms disagree about whether enumerating a store
is possible at all, and an API that works on one of three is worse than none.

## deepLink

```ts
deepLink.onOpen((url) => {
  /* ... */
});
await deepLink.protocols(); // ["myapp"]
```

Links to your application from anywhere on the machine, declared with
`protocols` in the config and registered with the OS by `vantail package`.

`onOpen` returns an unsubscribe function and delivers **any link that arrived
before it ran** - including the one that launched the application, which
otherwise reaches the runtime long before any page exists. Every handler sees
those, not only whichever registered first.

The URL is untrusted: any web page or program can open one, and the runtime
checks only that the scheme is one of yours. Verify an OAuth `state` rather
than trusting the callback arrived.

macOS delivers links to the running application. Windows and Linux start it
again with the URL in argv, which is what `singleInstance` is for - see
`app.onSecondInstance` for the other half.

Registration happens at package time: `CFBundleURLTypes` in the macOS bundle,
`MimeType=x-scheme-handler/...` in the `.desktop` entry, and `HKCU\Software\
Classes` keys in the `.msi`. During `vantail dev` there is no registration,
so pass the URL on the command line to try it.

## shell

```ts
await shell.open("https://example.com");
await shell.open("/Users/me/report.pdf", { with: "Preview" });
```

Denied unless `permissions.shell.open` allows it. See
[permissions.md](permissions.md#shellopen) for why that default matters.

## updater

See [updater.md](updater.md) for the publishing side.

| Function                          | Notes                                                       |
| --------------------------------- | ----------------------------------------------------------- |
| `check()`                         | `{ available, currentVersion, version?, notes?, pubDate? }` |
| `download(onProgress?)`           | Downloads and verifies. Does not install                    |
| `install()`                       | Swaps in the new version and relaunches. Never resolves     |
| `downloadAndInstall(onProgress?)` | Both                                                        |
| `pending()`                       | Whether a verified update is already on disk                |
| `onProgress(handler)`             | The same events, subscribed separately                      |

## Errors

```ts
import { VantailError } from "@vantail/api";

try {
  await filesystem.readText(path);
} catch (error) {
  if (VantailError.is(error, "PERMISSION_DENIED")) {
    /* ... */
  }
}
```

| Code                | Meaning                                                |
| ------------------- | ------------------------------------------------------ |
| `NO_RUNTIME`        | The page is not inside a Vantail window                |
| `UNKNOWN_METHOD`    | No such method - usually an SDK newer than the runtime |
| `INVALID_PARAMS`    | The native side rejected the arguments                 |
| `PERMISSION_DENIED` | Not allowed by `vantail.config.ts`                     |
| `NOT_FOUND`         | No such file or directory                              |
| `ALREADY_EXISTS`    |                                                        |
| `IO_ERROR`          | Everything else the filesystem reported                |
| `INVALID_UTF8`      | A text call on a file that is not text                 |
| `UNSUPPORTED`       | Not available on this platform or in this build        |
| `CANCELLED`         | The call was abandoned - see `network`'s `signal`      |
| `INTERNAL`          | A bug in Vantail                                       |

## Escape hatches

```ts
import {
  invoke,
  isVantail,
  listen,
  runtimeVersion,
  windowLabel,
} from "@vantail/api";

isVantail(); // running inside a Vantail window?
runtimeVersion(); // the native runtime's version
windowLabel(); // this window's label
await invoke<string>("os.platform"); // call a method the SDK does not wrap
listen("window.resized", (payload) => {}); // subscribe to a raw event
```

`invoke` and `listen` are the untyped layer everything else is built on. Reach
for them when the runtime has something the SDK has not caught up with.
