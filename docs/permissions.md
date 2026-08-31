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
    clientCertificates: ClientCertificate[],
    proxy: { url: string, for?: string[] },
    grantFromPrompt: boolean,      // default false
  },
  secrets: boolean,             // default false
  database: boolean,            // default false
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

`network.request` will only reach what `network.allow` names. Five rule forms,
and no others:

| Rule                       | Matches                                         |
| -------------------------- | ----------------------------------------------- |
| `api.example.com`            | that host exactly, any scheme, any port         |
| `*.example.com`              | anything strictly beneath it - **not** the apex |
| `*`                        | every host                                      |
| `192.168.0.0/16`           | any address in that range                       |
| `http://192.168.1.50:9123` | that scheme and host, and that port if given    |

`deny` is checked first and wins. A wildcard is either the whole rule or a
leading `*.`; `api.*.tv` is a configuration error rather than a surprise.

### When the host is not known until run time

Most applications should name their hosts, and the discipline is the point: a
compromised page cannot reach an attacker's server if the runtime has never
heard of it. But a whole class of application exists to talk to a host the
*user* names - an API client, a webhook inspector, a link checker, a feed
reader, anything with a URL bar. There is no list of hosts to write, and
guessing at one produces a config full of public suffixes that is
simultaneously far too broad for any one user and still not broad enough.

Say so instead:

```ts
network: {
  allow: ["*"],
  // Still worth denying what no application of yours should ever reach.
  deny: ["169.254.0.0/16", "metadata.google.internal"],
}
```

`*` is deliberately one legible line that a reviewer will see, in the same
file as every other permission - the same way `shell: { open: true }` is. It
does not switch anything else off: `deny` still wins, every redirect hop is
still checked, and a certificate is still verified unless
`allowInvalidCertificates` says otherwise.

`https://*` is the same thing with the scheme pinned, for an application that
will talk to anywhere but not in the clear.

### grantFromPrompt

`*` is the blunt answer. This is the narrow one:

```ts
network: {
  allow: ["*.internal"],
  grantFromPrompt: true,
}
```

A request to a host `allow` does not cover no longer fails outright. The
runtime shows a native dialog naming the host, and if the user says yes the
host is reachable for as long as the application is running. Saying no is an
ordinary `PERMISSION_DENIED`, indistinguishable from any other.

This is the same idea as `filesystem.grantFromDialog`, and for the same
reason: a narrow standing scope, widened by something the user visibly did.
The property worth keeping is that a page which has been taken over cannot
quietly exfiltrate to somewhere new, because a person has to read the host's
name and agree - and that property is *stronger* than what an application
which fell back to the webview's `fetch` had, since `fetch` asks nobody.

Four things it does not do:

- **`deny` still wins, and is never prompted for.** A denied host is a
  decision the developer already made; no dialog overturns it. Keep the link
  local metadata ranges in `deny` and they stay unreachable however many
  times a page asks.
- **A grant is one host, any scheme and port** - the same reach as writing
  that host in `allow`. It is not a wildcard, and it does not cover
  subdomains.
- **A grant does not survive the process.** Nothing is written anywhere, so
  the next launch starts from the config again.
- **A grant is not permission to skip certificate checks.** Those stay with
  `allowInvalidCertificates`.

The prompt is serialised: an application that fires five requests at a new
host at once asks once, and the other four find the answer already given. The
thread making the request waits while the dialog is open, which for the
runtime's fixed network queue means a slot is held until the user decides.

`ws` and `wss` are `http` and `https` for the purposes of a rule, whichever
way round you write it: `http://192.168.1.50:9123` covers a WebSocket to the
same host and port, and so does `https://api.example.com` for `wss://`. The
handshake is an HTTP GET on that port to that server, so separating them would
be ceremony rather than security. A bare host rule covers every scheme anyway.

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


### clientCertificates

```ts
network: {
  allow: ["*.bank.example"],
  clientCertificates: [
    {
      hosts: ["*.bank.example"],
      certificate: "$APPDATA/client.pem",
      key: "$APPDATA/client.key",
    },
  ],
}
```

Mutual TLS, which is how a good number of enterprise and financial APIs
authenticate. Both files are PEM; the certificate file may hold the whole
chain, and every intermediate in it is sent, since a missing intermediate is
the usual reason an otherwise valid certificate is rejected.

`hosts` is not optional and may not be empty. A client key is an identity, and
an entry that read as "present this to everyone" would hand that identity to
whatever host an application was talked into contacting. The first entry whose
`hosts` match is the one used, so put the specific rules first.

The files are read the first time a request needs them and kept after that, so
a certificate under `$APPDATA` can be provisioned after the application is
installed. A missing or unreadable file fails the request that needed it, not
the launch.

The paths take the same `$APPDATA`, `$APPCONFIG`, `$HOME` and `$RESOURCE`
variables as the filesystem scopes. Naming the file here *is* the grant: it is
in the permission file, where a reviewer will see it, rather than in a call
where it would not be.

### proxy

```ts
network: {
  allow: ["*.example.com"],
  proxy: { url: "http://127.0.0.1:8888", for: ["*.example.com"] },
}
```

How a developer inspects their own application's traffic, and how a good many
corporate networks require egress to go.

`for` is the list of hosts that go through it, in the same rule forms as
`allow`; leaving it out sends everything through the proxy. That distinction
matters on a desktop: an application that talks to both an internet API and a
hub on the user's own LAN wants the first proxied and the second not.

The URL is `<protocol>://<user>:<password>@<host>:<port>`, with everything but
the host optional. `http` and `https` (both CONNECT proxies) work in every
build. `socks4` and `socks5` need a runtime built with the `socks` feature,
which is off by default because it costs a dependency that most applications
will never use.

A proxy does not widen `allow`. The request is checked against the host it is
*for*, not the proxy it goes through, so routing through a proxy cannot be
used to reach somewhere the config does not permit.
## Storing data

```ts
permissions: {
  database: true,
  filesystem: { read: ["$APPDATA/**"], write: ["$APPDATA/**"] },
}
```

`database` is the capability; `filesystem.write` is still the reach. Both are
needed, and they answer different questions: whether this application may open
a SQLite database at all, and where it may put one. A database is a file, so
the path goes through exactly the same scope a `filesystem.writeText` would -
`$APPDATA/**` and the rest read the way they always did.

`database.snapshot` writes a second file, and that path is checked the same
way. Opening with `readOnly` needs only `filesystem.read`.

The database is not encrypted. `secrets` will hold a key perfectly well, but
there is nothing here to give it to, so an application that needs encryption at
rest needs something Vantail does not yet have. Say so in your interface rather
than showing a padlock that means nothing.

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

### A program you start is outside all of this

`shell.allow` gates *starting* a program. It does not follow it. Once a child
process is running it is an ordinary process with the user's privileges: the
files it reads, the hosts it connects to and the programs it starts in turn
are mediated by nothing on this page.

That matters most for a **sidecar** - a server shipped in the bundle and
spawned at startup, which the interface then talks to over a local socket. It
is a second principal with more authority than the application that started
it, and the rules here are not in that path:

- `permissions.network` bounds `fetch` **from the webview**. It says nothing
  about where the sidecar connects.
- `permissions.filesystem` bounds the filesystem API. The sidecar reads and
  writes as the user.
- `shell.allow` bounds what the *runtime* starts. It does not bound what the
  sidecar starts.

So the socket becomes the trust boundary, and it needs rules of its own.
Whatever authenticates it - usually a token handed to the page - is the entire
gate, and it is held by the least trustworthy part of the application: a
webview rendering content from elsewhere. Give the sidecar its own allow-list
for anything it will connect to or execute on the page's say-so, rather than
assuming the caller is trustworthy because it knew a token.

Note in particular that allowing one program can allow every program. A rule
naming an interpreter, a package runner (`npx -y`, `uvx`, `pipx`) or anything
else that fetches code and runs it means "may run arbitrary code" no matter
how tightly the arguments are pinned. Prefer a binary you shipped.
