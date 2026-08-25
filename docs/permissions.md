# Permissions

A Vantail application is a webview. If it can be made to run someone else's
JavaScript - a compromised dependency, a rendered chunk of remote content -
then whatever the app can do, that JavaScript can do. The permission layer is
the answer to "and how much is that?"

Three principles:

1. **Deny by default.** A capability exists only because the config asked for
   it. Adding a new API to the runtime does not silently grant it to existing
   apps.
2. **Check the resolved path, use the resolved path.** The path that was
   validated is the path that gets opened.
3. **The user's choice is an authorisation.** A file picked in a native dialog
   is granted, so scopes can stay narrow without making the app useless.

## Shape

```ts
permissions: {
  filesystem: {
    read: PathScope,
    write: PathScope,
    grantFromDialog: boolean,   // default true
  },
  dialog: boolean,              // default false
  clipboard: boolean | { read: boolean, write: boolean },  // default false
  notification: boolean,        // default false
  menu: boolean,                // default false
  tray: boolean,                // default false
  updater: boolean,             // default false
  shell: {
    allow: ShellRule[],         // default: nothing
    open: boolean | string[],   // default false
  },
  network: {
    allow: string[],            // default: nothing
    deny: string[],
    allowInvalidCertificates: string[],
  },
  secrets: boolean,             // default false
  mdns: boolean | string[],     // default: nothing
  hid: boolean | HidRule[],     // default: nothing
  os: boolean,                  // default true
  window: boolean,              // default true
}
```

`os` and `window` default to `true` because they are not privileges: an app
reading its own window size or the name of the platform it is running on is
not reaching outside itself. Everything else starts closed.

Omitting the `permissions` block entirely gives you exactly these defaults -
windows and machine facts, and nothing else.

## Path scopes

A `PathScope` is one of four things:

```ts
read: false                                   // nothing
read: true                                    // everything
read: ["$DOCUMENT/**", "$APPDATA/**"]         // these globs
read: { allow: ["$HOME/**"], deny: ["$HOME/.ssh/**"] }
```

`deny` always wins.

### Globs

- `*` matches within one path segment and stops at `/`.
- `**` crosses directory boundaries.
- `a/b/**` also matches `a/b` itself, so listing the directory you granted
  works.

`read: ["$HOME/projects/*"]` therefore allows `$HOME/projects/notes.txt` but
not `$HOME/projects/app/src/main.ts`. Use `**` when you mean a whole tree.

### Variables

| Variable                            | Resolves to                                       |
| ----------------------------------- | ------------------------------------------------- |
| `$HOME`                             | The user's home directory                         |
| `$DESKTOP` `$DOCUMENT` `$DOWNLOAD`  | The matching user directories                     |
| `$PICTURE` `$VIDEO` `$AUDIO`        | The matching media directories                    |
| `$TEMP`                             | The system temporary directory                    |
| `$CWD`                              | The directory the runtime was launched from       |
| `$RESOURCE`                         | The app's own bundled assets                      |
| `$APPDATA` `$APPCONFIG` `$APPCACHE` | Per-app directories, named after `app.identifier` |

Variables and the fixed leading part of every pattern are resolved through
symlinks when the scope is compiled - so a scope written as `/tmp/**` still
matches on macOS, where `/tmp` is `/private/tmp`.

## How a path is checked

```text
"/Users/jeroen/docs/../notes.txt"
        |
        +- make absolute
        +- resolve "." and ".." lexically
        +- canonicalise the part that exists  (follows symlinks)
        +- re-append the part that does not
        v
"/Users/jeroen/notes.txt"
        |
        +- granted by a dialog this session?  --> allow
        +- matched by `deny`?                 --> deny
        +- matched by `allow`?                --> allow
        +- otherwise                          --> deny
```

The normalised path is what the handler then opens. This is the part that
makes the check meaningful: if the check ran on one path and the operation on
another, a symlink or a `..` could put those two out of step. They cannot get
out of step here, because there is only one path after normalisation.

A denial is a `VantailError`:

```json
{
  "code": "PERMISSION_DENIED",
  "message": "`filesystem.read` is not allowed for /etc/passwd. Allowed: /Users/jeroen/Documents/**",
  "data": { "path": "/etc/passwd", "access": "filesystem.read" }
}
```

The message names what _was_ allowed, because the most common cause of a
denial is a scope that is one glob away from correct.

## Dialog grants

```ts
permissions: {
  dialog: true,
  filesystem: { read: [] },   // nothing, standing
}
```

```ts
const path = await dialog.openFile(); // user picks ~/Desktop/report.pdf
await filesystem.readText(path); // works
await filesystem.readText("/etc/passwd"); // PERMISSION_DENIED
```

Picking `report.pdf` granted `report.pdf` - not `~/Desktop`, and not PDFs in
general. `openDirectory` grants the directory and everything beneath it, which
is what a user who picked a folder expects. `saveFile` grants write _and_
read, since an app that just wrote a file should be able to read it back.

Grants live in memory and disappear when the app quits. Set
`filesystem.grantFromDialog: false` if you want the standing scope to be the
only thing that matters.

## Running programs

`process.execute` and `process.spawn` will only start what `shell.allow`
names.

```ts
shell: {
  allow: [
    // Exactly this command, and nothing else.
    { program: "git", args: ["status", "--porcelain"] },

    // A fixed subcommand with one free argument.
    { program: "git", args: ["log", { pattern: "-n*" }] },

    // Any arguments at all - which for most programs is the same as
    // allowing anything.
    { program: "/usr/bin/uptime" },

    // A sidecar shipped inside the bundle, allowed to run in one place.
    { program: "$RESOURCE/bin/convert", cwd: ["$APPDATA/**"] },
  ],
}
```

Three things make this hold:

**There is no shell.** The program is looked up by exact name and its
arguments are handed to `execve` as a vector. There is no command string for
anything to be injected into. Escaping is not being done carefully here; it is
not being done at all, because there is nothing to escape.

**The number of argument rules is the number of arguments.** `args: ["status"]`
allows exactly one argument, and it must be `status`. `args: []` allows none.
Omitting `args` allows any - say so deliberately.

**A working directory is denied unless the rule allows it.** A call that passes
no `cwd` inherits the runtime's; a call that passes one is checked against
that rule's `cwd` scope, using the same path rules as the filesystem section
above.

Patterns in `args` use `*` that _does_ cross `/`, unlike path scopes: these
are command arguments, not paths.

### shell.open

```ts
shell: {
  open: ["https://*", "mailto:*"];
}
```

Handing something to the system's default application is a small API with a
large blast radius - on every platform, "open this path" can mean "run this
program". It is denied by default, and the pattern is matched against the
exact string the application passed, before any resolution.

`open: true` allows anything, including `/Applications/Anything.app`. Prefer a
list of URL schemes.

## Reaching the network

`network.request` will only reach what `network.allow` names. Four rule forms,
and no others:

| Rule                       | Matches                                         |
| -------------------------- | ----------------------------------------------- |
| `api.example.com`            | that host exactly, any scheme, any port         |
| `*.example.com`              | anything strictly beneath it - **not** the apex |
| `192.168.0.0/16`           | any address in that range                       |
| `http://192.168.1.50:9123` | that scheme and host, and that port if given    |

`deny` is checked first and wins. A wildcard is only allowed as a leading
`*.`; `api.*.tv` is a configuration error rather than a surprise.

A CIDR rule matches addresses, not names. `hub.local` is not covered by
`192.168.0.0/16` even if it resolves there, because the check happens before
resolution - use `*.local` for names.

Two properties matter more than the rules:

**Every redirect hop is checked.** A permitted host that redirects to a denied
one would otherwise be a way straight through the fence, so redirects are
followed by the runtime a hop at a time rather than by the HTTP client.

**Credentials do not survive a cross-host redirect.** `Authorization`,
`Cookie` and `Proxy-Authorization` are dropped when a redirect changes host,
the way a browser drops them.

### allowInvalidCertificates

```ts
network: {
  allow: ["192.168.0.0/16", "api.example.com"],
  allowInvalidCertificates: ["192.168.0.0/16"],
}
```

A smart-home hub serves its local API over HTTPS with a self-signed
certificate, so reaching it at all means not verifying it. That is a real
decision with a real cost, which is why it is a separate list: being allowed
to talk to a host is not permission to stop checking who is answering as
the service.

It applies automatically to hosts in the list - the config is where the
decision lives, not each call site.

## Devices

```ts
permissions: {
  secrets: true,
  mdns: ["_hub._tcp.local", "_elg._tcp.local"],
  hid: [{ vendorId: 0x0fd9 }],
}
```

**`mdns` is scoped by service type**, because "find me the lights" and
"enumerate everything on this network" are different requests and only one of
them is what an application usually means.

**`hid` is scoped by what the hardware reports about itself** - `vendorId`,
optionally `productId` and `usagePage`. Not by name: a name is whatever the
device claims, and an id is assigned.

`hid.list()` returns only permitted devices. An application allowed to talk to
one vendor's hardware has no business learning what else is plugged in, so the
filter is applied to enumeration as well as to opening.

**`secrets` is a plain boolean.** Entries are namespaced by the application's
`identifier` regardless, so two applications cannot reach each other's.

## Shortcuts and starting at login

```ts
permissions: {
  shortcut: true,   // claim key combinations system-wide
  autostart: true,  // start when the user logs in
}
```

Both are off by default and neither is scoped further. A global shortcut takes
a combination away from every other application while yours runs, and
autostart writes into the user's login items - so they are worth granting on
purpose rather than by inheritance.

## Menus, tray and the updater

`menu`, `tray` and `updater` are plain booleans. They are separate from
`window` because they reach outside the application's own windows: a menu bar
and a tray icon are visible when the app is not, and the updater downloads and
executes code.

## What this does not protect against

The permission layer bounds what the _application_ can reach. It is not a
sandbox: the runtime process itself runs with the user's full privileges, and
a compromise of the runtime binary is a compromise of the account.

It also does not protect against an application that asks for
`filesystem: { read: true, write: true }`. Scopes are only as good as the ones
you write.
