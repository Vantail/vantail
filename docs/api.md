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
| `set(items)`                                      | Replaces the application menu                      |
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

Accelerators are strings like `CmdOrCtrl+S`, `Alt+Shift+F4`, `CmdOrCtrl+Plus`.
An unparseable one is `INVALID_PARAMS` rather than a silently missing binding.

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

An app that keeps running with no window open also wants
`quitOnLastWindowClosed: false` in its config.

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
```

An HTTP client in the runtime rather than the webview. **Use `fetch` for the
internet**; this is for what `fetch` refuses: a self-signed certificate, or a
device that sends no CORS headers.

| Option         | Notes                                                             |
| -------------- | ----------------------------------------------------------------- |
| `url`          | Absolute. Checked against `permissions.network`                   |
| `method`       | Default `GET`. Any method the server understands                  |
| `headers`      | Sent verbatim. A newline in a value is an error, not an injection |
| `body`         | Sent as UTF-8                                                     |
| `bytes`        | Sent as raw bytes. Wins over `body`                               |
| `timeoutMs`    | Default 30000                                                     |
| `maxRedirects` | Default 5. Every hop is permission-checked                        |

The response carries `url` (after redirects), `status`, `statusText`, `ok`,
lower-cased `headers` with repeats joined by `, `, and `body`.

A non-2xx status is an answer, not an exception - only a transport failure
rejects.

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
