# Vantail

**A thin native layer for JavaScript applications.**

```bash
npm create @vantail my-app
cd my-app
npm install
npm run dev
```

Templates for React, Svelte, Vue and plain TypeScript - pick one when asked, or
pass `--template svelte-ts`.

```ts
import { dialog, filesystem } from "@vantail/api";

const path = await dialog.openFile();

if (path) {
  console.log(await filesystem.readText(path));
}
```

That is the whole idea. You write TypeScript and a web interface; Vantail gives
it a native window, native dialogs, and scoped access to the filesystem. No
Rust project, no Chromium, no Node.js, no localhost server.

The native side is a precompiled runtime you never build or modify. It exposes
a small set of APIs over a typed IPC channel, and that is the whole contract:
your project is a TypeScript project, with no toolchain beyond npm. The other
side of that trade is that there is no native command to add - what the
runtime exposes is what you get.

## How it fits together

```text
+--------------------------------------------+
|              Your application              |
|      React / Vue / Svelte / vanilla TS     |
|                                            |
|   import { filesystem } from "@vantail/api"|
+--------------------+-----------------------+
                     |  typed calls
                     v
+--------------------------------------------+
|              @vantail/api                  |
|    promises, errors, event subscriptions   |
+--------------------+-----------------------+
                     |  JSON over the webview's own IPC
                     v
+--------------------------------------------+
|           vantail-runtime  (Rust)          |
|                                            |
|  router | permissions | filesystem         |
|  dialogs | clipboard | window | lifecycle  |
+--------------------+-----------------------+
                     |
        +------------+------------+
        v            v            v
     Windows       macOS        Linux
     WebView2     WKWebView    WebKitGTK
```

Two things are worth calling out, because they are what make this small:

**There is no local server.** Messages travel over the platform's own webview
IPC channel - `window.ipc.postMessage` in, `evaluate_script` out. No port, no
WebSocket, no authentication token needed to talk to ourselves. In production
assets are served straight off disk through a `vantail://` custom protocol.

**There is no Node.js.** `node:fs` does not exist in a Vantail app, and neither
does `require`. Any browser-compatible npm package works - React, Vue, Zod,
D3, TanStack Query. Anything that reaches for Node's standard library does
not, and `@vantail/api` is the replacement.

## The API

```text
app            name | version | identifier | info | infoSync | isDev
               emit | listen | quit | restart

appWindow      setTitle | title | setSize | size | setPosition | position
               minimize | maximize | unmaximize | toggleMaximize | isMaximized
               setFullscreen | isFullscreen | setResizable | setAlwaysOnTop
               show | hide | isVisible | focus | center | close | exists
               setCloseBehavior | closeBehavior | openDevtools
               onResized | onMoved | onFocusChanged | onCloseRequested

               createWindow | getWindow | listWindows | currentWindow
               onWindowCreated | onWindowReady | onWindowClosed

filesystem     readText | writeText | appendText | readBinary | writeBinary
               readDir | exists | stat | mkdir | remove | copy | rename

dialog         openFile | openFiles | openDirectory | openDirectories
               saveFile | message | confirm

clipboard      readText | writeText | hasText | clear

menu           set | remove | popup | setEnabled | setLabel
               setChecked | isChecked | onClick

tray           set | remove | exists | setIcon | setTooltip | setTitle
               setVisible | setMenu | onClick | onDoubleClick

process        execute | spawn | list
               child: write | closeStdin | kill | onStdout | onStderr | onExit

network        request | json | binary

mdns           discover | browse | stop | browsing | onFound | onLost

hid            list | open | opened
               connection: write | sendFeatureReport | getFeatureReport
                           close | onInput | onClosed

secrets        set | get | has | delete

shell          open

updater        check | download | install | downloadAndInstall | pending
               onProgress

os             platform | arch | info | infoSync | homeDir | tempDir
               appDataDir | appConfigDir | resourceDir

notification   show
```

Everything returns a promise. Failures reject with a `VantailError` carrying a
stable `code`:

```ts
import { filesystem, VantailError } from "@vantail/api";

try {
  await filesystem.readText("/etc/passwd");
} catch (error) {
  if (VantailError.is(error, "PERMISSION_DENIED")) {
    // ask the user to pick a file instead
  }
}
```

## Permissions

Nothing native is available until the config asks for it. This is not a
feature to add later - it is in from the first commit, because a webview that
can read any file is a webview that can exfiltrate any file.

```ts
// vantail.config.ts
import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "My App",
    identifier: "dev.wissen.myapp",
    version: "1.0.0",
  },

  window: { width: 1200, height: 800 },

  permissions: {
    dialog: true,
    clipboard: { read: false, write: true },
    menu: true,
    tray: true,

    filesystem: {
      read: ["$DOCUMENT/**"],
      write: {
        allow: ["$APPDATA/**"],
        deny: ["$APPDATA/secrets/**"],
      },
    },

    shell: {
      allow: [{ program: "git", args: ["status", "--porcelain"] }],
      open: ["https://*"],
    },

    network: {
      allow: ["api.example.com", "192.168.0.0/16", "*.local"],
      // A smart-home hub serves HTTPS with a self-signed certificate. Being
      // allowed to reach a host is not permission to stop checking who is
      // answering, so that is its own list.
      allowInvalidCertificates: ["192.168.0.0/16"],
    },
  },
});
```

Two details that matter in practice:

**A path the user picks in a dialog is granted for the session.** So the scope
above can stay narrow and `dialog.openFile()` still opens anything the user
chooses. The user's decision _is_ the authorisation. Turn it off with
`filesystem.grantFromDialog: false`.

**Checks run against the resolved path, and the resolved path is what gets
opened.** `..` is resolved and symlinks are followed _before_ the check, and
the handler then operates on that same path - so a symlink inside an allowed
directory cannot be used to reach outside it.

Patterns understand `$HOME`, `$DESKTOP`, `$DOCUMENT`, `$DOWNLOAD`,
`$PICTURE`, `$VIDEO`, `$AUDIO`, `$TEMP`, `$CWD`, `$RESOURCE`, `$APPDATA`,
`$APPCONFIG` and `$APPCACHE`. A single `*` stops at a directory boundary;
`**` crosses it.

**Running programs is a list of exact commands, not a shell.** Arguments go
straight to `execve` as a vector - there is never a command string for
something else to re-parse, so shell injection is not mitigated here, it is
absent. Each rule pins the program and, if you want, every argument position.

## The window is a frame, not a page

Two defaults follow from that, and neither needs any code.

**It does not scroll.** The document stays put, does not rubber-band at its
edges, and has no scrollbars. What scrolls is the panes inside it, on their
own `overflow`. A window that really is a document says so:

```ts
// vantail.config.ts
window: { scroll: true },
```

**A hidden title bar still drags.** `titleBarStyle: "hidden"` lets the page run
to the top edge, and the runtime moves the window from the band that bar left
behind - a double click there maximises it, and controls in it are skipped.

Three attributes adjust both:

| Attribute                | Effect                                          |
| ------------------------ | ----------------------------------------------- |
| `data-vantail-drag`      | This subtree moves the window                    |
| `data-vantail-no-drag`   | This subtree does not                            |
| `data-vantail-scrollbar` | This subtree keeps its scrollbars                |

[docs/api.md](docs/api.md) has the rest.

## More than one window

Windows are named by a **label**. `main` is the one the config opens; the rest
are opened at runtime and every call names one, defaulting to the window that
made it.

```ts
import { app, appWindow, createWindow, getWindow } from "@vantail/api";

// Resolves once the new window's page is running, so the message below cannot
// arrive before anything is listening for it.
const settings = await createWindow("settings", {
  url: "settings.html",
  width: 420,
  height: 300,
});

await settings.setTitle("Settings");
await app.emit("hello", { from: "main" }, { to: "settings" });

// ...and in the settings window
app.listen<{ from: string }>("hello", ({ from }) => console.log(from));
```

Two windows are two webviews with nothing shared between them, so anything
they need to tell each other goes out through the runtime and back in -
`app.emit` and `app.listen` are that round trip.

## Menus, tray, and everything outside the window

```ts
await menu.set([
  {
    type: "submenu",
    label: "File",
    items: [
      { id: "open", label: "Open...", accelerator: "CmdOrCtrl+O" },
      { type: "separator" },
      { type: "predefined", item: "quit" },
    ],
  },
]);

menu.onClick(({ id }) => {
  if (id === "open") openFile();
});
```

On macOS a menu is not decoration: without one, Cmd-W, Cmd-Q, Cmd-C, Cmd-V,
Cmd-Z and Cmd-M do nothing whatsoever. So **an application that sets no menu
gets the standard macOS one** - About, Hide, Quit, the Edit items and a Window
menu - and all of those shortcuts work out of the box. Pass `menu: []` if you
want no menu on purpose.

Cmd-W goes through `closeBehavior`, so a tray application hides rather than
quitting; Cmd-Q always quits, and shuts down child processes and open devices
on the way.

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

A left click brings the window back if it is hidden, focuses it if it is
behind something, and opens the menu if it is already in front - which is what
a tray icon is usually for. A right click always opens the menu. Set
`leftClick: "menu"` for the older macOS convention, or `"event"` to decide for
yourself.

An app that lives in the tray with no window open also wants
`quitOnLastWindowClosed: false` in its config, and on macOS `showInDock: false`
so it has no Dock icon either. `onClick` reports the icon's position in
*physical* pixels, while `setPosition` takes logical ones - see
[examples/tray](examples/tray).

## Talking to hardware

Use the ordinary `fetch` for the internet - it works, and it is the thing you
already know. `network.request` is for what `fetch` cannot do: a smart-home
bridge serves HTTPS with a self-signed certificate, and a smart light or a
desk display sends no CORS headers, so the webview makes the request and
then refuses to let you read the answer.

```ts
await network.request({
  url: `http://${light.host}:9123/api/lights`,
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ lights: [{ on: 1, brightness: 80 }] }),
});
```

Every redirect hop is checked against `permissions.network`, and
`Authorization` is dropped when one crosses hosts.

What already works in the webview stays there: WebSockets reach both LAN
devices and cloud endpoints, `crypto.subtle` covers OAuth PKCE, and
`IndexedDB` survives restarts.

## Staying alive with no window

```ts
// vantail.config.ts
window: { closeBehavior: "hide" },
quitOnLastWindowClosed: false,
showInDock: false, // macOS: no Dock icon, no Cmd-Tab entry
```

The close button hides the window; the webview keeps running, so timers keep
firing and sockets stay connected. Only `app.quit()` - from a tray menu, say -
actually ends the process.

## Devices on the network, and devices on the wire

```ts
// Find them - no browser can hear multicast DNS.
const [bridge] = await mdns.discover({ service: "_hub._tcp.local" });

// Talk to them, even with a self-signed certificate and no CORS headers.
await network.request({
  url: `https://${bridge.addresses[0]}/clip/v2/resource/light/${id}`,
  method: "PUT",
  body: JSON.stringify({ on: { on: true } }),
});

// And for things on USB, since WebHID does not exist here.
const [deck] = await hid.list();
const connection = await hid.open(deck.id);
connection.onInput((report) => decodeButtons(report));
```

Vantail knows what a service type, an HTTP request and a HID report are. It
has never heard of any of those vendors - the adapters are your code.

Tokens go in the OS credential store rather than `localStorage`, which is a
plaintext file anything running as the user can read:

```ts
await secrets.set("service.refreshToken", token);
```

## Links back into your application

```ts
// vantail.config.ts
protocols: ["myapp"],
```

```ts
deepLink.onOpen((url) => {
  const code = new URL(url).searchParams.get("code");
  if (code) void exchangeForToken(code);
});
```

Which is how a desktop application finishes an OAuth sign-in: the browser
needs somewhere to send the user back to, and `myapp://callback` is it.

Declaring a protocol turns on **single instance**, because on Windows and
Linux a link arrives by starting the application _again_ with the URL in its
arguments - so unless the second process hands it over and exits, the link
opens a second copy instead of signing anyone in. The handover is a local
socket, not a TCP port.

A link that _launched_ the application is held until you register a handler,
so the link that started the app can never be missed.

**Treat the URL as input from a stranger.** Anything on the machine can open
one; the runtime guarantees only that the scheme is yours.

## Running other programs

```ts
const { stdout } = await process.execute("git", ["status", "--porcelain"]);

const build = await process.spawn("npm", ["run", "build"]);
build.onStdout((chunk) => append(chunk));
build.onExit(({ code }) => done(code));
```

Only what `permissions.shell.allow` names, and only with the arguments it
allows. Output arrives in chunks rather than lines, because a program drawing
a progress bar with `\r` never emits a newline and would otherwise look hung.

## Updating itself

```ts
const update = await updater.check();

if (update.available && (await dialog.confirm(`Install ${update.version}?`))) {
  await updater.downloadAndInstall(({ downloaded, total }) =>
    setProgress(downloaded / total),
  );
}
```

Publishing is three commands:

```bash
vantail updater keygen                    # once, ever
vantail package --update                  # on each release machine
vantail updater manifest darwin-aarch64=... --base-url https://...
```

Nothing is extracted before its Ed25519 signature has been checked against the
public key compiled into the app, so whoever controls the update endpoint can
stop an update but cannot substitute one. See
[docs/updater.md](docs/updater.md).

## The command line

```bash
vantail dev        # native window against the Vite dev server, with HMR
vantail build      # build the web assets
vantail package    # lay out a distributable application
vantail doctor     # check that everything needed to run is present
vantail updater    # keygen | sign | manifest
```

`vantail dev` starts Vite, points a real webview at it, and ties their
lifetimes together - close the window and the server stops; stop the CLI and
the window closes. Editing `vantail.config.ts` reopens the window with the new
settings, since window size and permissions are read once at startup.

`vantail package` produces a `.app` on macOS and a portable folder elsewhere.
It copies a precompiled runtime binary; there is no compilation step and no
Rust toolchain involved.

Add `--installer` and it also builds the thing a user downloads: a `.dmg` on
macOS, an `.msi` on Windows, a `.deb` on Linux.

Icons come from one square PNG:

```ts
app: { name: "My App", identifier: "dev.wissen.myapp", icon: "icon.png" }
```

Every size each platform asks for is scaled down from it - an `.icns` for the
macOS bundle, an `.ico` for Windows, and the hicolor theme sizes for the
Debian package. Give it 1024x1024 if you have it; 256x256 is the minimum,
because scaling _up_ looks worse than the platform placeholder.

For scale: the release runtime is a 4.1 MB binary with every capability
compiled in - two windows, menus, tray, dialogs, clipboard, subprocesses, the
scoped filesystem, HID, mDNS, the keychain, the network client, WebSocket,
SQLite and the self-updater. With the optional capabilities turned off it is
2.1 MB.

SQLite is 885 KB of that, which is more than everything else optional put
together. It is compiled in rather than linked against whatever version the
machine happens to have, because a database whose behaviour changes with the
user's OS release is not one you can write a migration for. If your
application does not store anything, `--no-default-features --features
devtools,network` gets most of the way back down.

If you ever see a bundle ten times that, it is a debug runtime: `vantail
package` refuses one unless you pass `--allow-debug-runtime`.

## Packages

| Package                                | What it is                                                       |
| -------------------------------------- | ---------------------------------------------------------------- |
| [`@vantail/api`](packages/api)         | The SDK you import in application code. Zero dependencies.       |
| [`@vantail/cli`](packages/cli)         | `vantail dev`, `build`, `package`, `doctor`, and `defineConfig`. |
| [`@vantail/vite`](packages/vite)       | Vite plugin. Applied automatically by the CLI.                   |
| [`@vantail/runtime`](packages/runtime) | Finds the precompiled native binary for the current platform.    |
| [`@vantail/shared`](packages/shared)   | Config types, schema, and the config loader. Tooling only.       |
| [`@vantail/create`](packages/create)   | `npm create @vantail`.                                           |
| [`runtime/`](runtime)                  | The Rust runtime itself. Not a dependency of your project.       |

## Examples

- [examples/showcase](examples/showcase) - a panel for every API, with the
  calls that are meant to be refused shown alongside the ones that work.
- [examples/react](examples/react) - a smaller, more realistic application.
- [examples/vanilla](examples/vanilla) - the same idea without a framework.

And seven built around a particular shape of window:

| Example                                | Stack           | What it is for                                                     |
| -------------------------------------- | --------------- | ------------------------------------------------------------------ |
| [tray](examples/tray)                   | Vue 3           | A menu bar application: no Dock icon, no window at rest, a popover placed under the icon |
| [sidebar](examples/sidebar)             | React           | The Mail and Xcode layout - a sidebar-split title bar, where the window buttons' inset moves between columns |
| [tabs](examples/tabs)                   | React           | Tabs drawn in the title bar, Chrome-style                          |
| [workspace](examples/workspace)         | React           | A two-row bar - a dark command bar with a tab strip under it, after the Windows shape |
| [player](examples/player)               | React           | A tall media bar with transport controls                           |
| [splash](examples/splash)               | none            | A frameless splash with its own corner radii, handing over to the app window |
| [chat](examples/chat)                   | Bun, Hono, htmx | Server-rendered, with the server shipped as a compiled sidecar     |

Run one against a local build with `vantail dev` - or `pnpm dev` in the
example's own directory, which is the same thing.

## Further reading

- [docs/api.md](docs/api.md) - every method, its arguments and what it returns.
- [docs/architecture.md](docs/architecture.md) - how a call gets from
  JavaScript to the OS and back.
- [docs/permissions.md](docs/permissions.md) - the permission model in full.
- [docs/packaging.md](docs/packaging.md) - bundles, installers and signing.
- [docs/updater.md](docs/updater.md) - signing keys, manifests, and what
  `install` actually does.
- [CHANGELOG.md](CHANGELOG.md) - what changed in each release.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
