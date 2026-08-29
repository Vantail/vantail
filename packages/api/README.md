# @vantail/api

The JavaScript SDK for [Vantail](https://github.com/Vantail/vantail): native
APIs for an application whose interface is a web page.

```bash
npm create @vantail my-app
```

Already have a project, this is installed for you by the scaffolder. Otherwise:

```bash
npm install @vantail/api
```

## What it does

Your application is TypeScript and a web interface. This package is how it
reaches the things a browser cannot: the filesystem, native dialogs, the menu
bar, the tray, the clipboard, other processes, USB devices.

```ts
import { dialog, filesystem } from "@vantail/api";

const path = await dialog.openFile();

if (path) {
  console.log(await filesystem.readText(path));
}
```

There is no Node.js underneath. `node:fs` does not exist in a Vantail app and
neither does `require`; any browser-compatible npm package works, and this is
the replacement for the rest.

## What is in it

```text
app            identity, lifecycle, and an event bus between windows
appWindow      size, position, state, fullscreen, always-on-top, devtools
               titleBarStyle for drawing your own, titleBarMetrics to size it
               createWindow, getWindow, listWindows, currentWindow for more
               than one, and onWindowCreated / onWindowReady / onWindowClosed
               to hear about them

filesystem     read, write, copy, rename, watch - text and binary
dialog         open, save, message, confirm - drawn by the OS
fileDrop       files dragged onto the window, as real paths
clipboard      text and images

menu           the application menu, and context menus
tray           an icon in the menu bar or system tray
notification   a notification from the OS
shortcut       key combinations claimed system-wide
autostart      starting when the user logs in
power          notices when the machine suspends and resumes
screen         the monitors attached, in logical pixels
os             platform, architecture, and per-application directories
path           joining and splitting paths, without a round trip

process        run another program, stream its output
shell          hand a URL or file to whatever owns it
network        HTTP from the runtime, past CORS - buffered, streamed,
               or upgraded to a WebSocket
database       SQLite in a file the user owns, optionally encrypted
mdns           discover services on the local network
hid            talk to USB HID hardware
secrets        the platform keychain
deepLink       your own URL scheme
updater        check, download, install, relaunch
```

Everything returns a promise. Failures reject with a `VantailError` carrying a
stable `code`, which is what you branch on:

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

## Nothing is available by default

Every native capability is denied until `vantail.config.ts` asks for it. A
webview that can read any file is a webview that can exfiltrate any file, so
the scope is something you write down:

```ts
permissions: {
  dialog: true,
  filesystem: {
    read: ["$DOCUMENT/**"],
    write: ["$APPDATA/**"],
  },
}
```

A path the user picks in a dialog, or drops on the window, is granted for the
session on top of that - so the standing scope can stay narrow and
`dialog.openFile()` still opens anything they choose.

## Documentation

- [Every method, argument and return](https://github.com/Vantail/vantail/blob/main/docs/api.md)
- [The permission model in full](https://github.com/Vantail/vantail/blob/main/docs/permissions.md)
- [How a call reaches the OS and back](https://github.com/Vantail/vantail/blob/main/docs/architecture.md)

Zero dependencies. MIT licensed.
