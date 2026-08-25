# Updating

An application that can replace itself is an application that can be replaced
by someone else. So the whole design here is one property: **nothing is
extracted before its signature has been checked against a key that was
compiled into the running application.**

Whoever controls your update endpoint - or the network between it and your
user - can stop an update. They cannot substitute one.

## The shape of it

Three calls rather than one, because they fail for different reasons and an
application usually wants to say something different about each.

```ts
import { dialog, updater } from "@vantail/api";

const update = await updater.check(); // a network call
if (!update.available) return;

const yes = await dialog.confirm(`Install ${update.version}?`, {
  title: "Update available",
});
if (!yes) return;

await updater.download(({ downloaded, total }) => {
  // minutes, with progress
  setProgress(total ? downloaded / total : 0);
});

await updater.install(); // restarts the application
```

`downloadAndInstall(onProgress)` does the last two together.

`install()` never resolves - the process is replaced. Save anything you care
about before calling it.

`pending()` tells you whether a verified archive is already on disk, which is
what lets an app download in the background and install on next launch.

## Publishing

### Once, ever

```bash
vantail updater keygen
```

Writes an Ed25519 private key to `.vantail/updater.key` (mode 600) and prints
the public half to paste into your config:

```ts
updater: {
  endpoint: "https://downloads.example.com/latest.json",
  publicKey: "u94h2NcqmDKgNRa3tNWIOfgT5CN19mylgZ21a1TW96E=",
}
```

**The private key is the only thing standing between your users and somebody
else's update.** Keep it out of version control. In CI, put the PEM in a
secret and expose it as `VANTAIL_UPDATER_KEY` rather than writing it to disk.

Losing it means every installed copy of your app can no longer update, because
they will all refuse anything signed by the replacement key. There is no
recovery for that other than shipping a new build by hand.

### On each release

Every platform has to be packaged on that platform, so this part runs once per
build machine:

```bash
vantail package --update
```

That produces the usual bundle plus `<App>-<version>-<platform>-<arch>.tar.gz`
next to it.

Then, wherever the archives end up together:

```bash
vantail updater manifest \
  darwin-aarch64=App-1.1.0-darwin-aarch64.tar.gz \
  darwin-x86_64=App-1.1.0-darwin-x86_64.tar.gz \
  windows-x86_64=App-1.1.0-windows-x86_64.tar.gz \
  --base-url https://downloads.example.com/1.1.0 \
  --notes "Fixes the thing" \
  --out latest.json
```

The target can be left out when the file is named as `vantail package --update`
names it; it is parsed back out of the filename.

Signing happens here rather than in `package`, so the private key only has to
exist on the one machine that assembles a release.

## The manifest

```json
{
  "version": "1.1.0",
  "notes": "Fixes the thing",
  "pubDate": "2026-08-22T09:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://downloads.example.com/1.1.0/App-1.1.0-darwin-aarch64.tar.gz",
      "signature": "B5XlVy0pAcaNt/4GCPqqxQj/..."
    }
  }
}
```

Serve it at your `endpoint`. The URL may contain `{{target}}`, `{{arch}}` and
`{{currentVersion}}`, which are substituted before the request - useful if you
would rather answer per platform than publish one document.

Target keys are `<platform>-<arch>` using Rust's spelling: `darwin-aarch64`,
`darwin-x86_64`, `windows-x86_64`, `linux-x86_64`, `linux-aarch64`.

Versions are compared the way semver says, so `1.10.0` is newer than `1.9.0`
and `1.2.0-beta.1` is older than `1.2.0`. An update is offered only when the
manifest names something strictly newer than the running version.

## What install actually does

```text
1. Verify the signature over the downloaded bytes.   <- before anything else
2. Extract the archive to a staging directory.
3. Rename the installed application to <name>.old.
4. Rename the extracted one into its place.
5. Launch it, and exit.
6. On the next start, delete <name>.old.
```

Step 3 is a rename rather than a delete so that a failure at step 4 can put
things back. Step 6 happens at startup because the process doing the deleting
would otherwise be running out of the directory it is deleting.

On macOS the unit that gets replaced is the `.app` bundle. Elsewhere it is the
folder holding the executable.

## Limits

- **The archive is downloaded into memory** before it is verified and written.
  There is a 512 MB ceiling; an app shipping more than that in one bundle
  needs a different approach.
- **Signature verification is not code signing.** On macOS the replacement
  bundle still needs its own Developer ID signature to satisfy Gatekeeper on a
  machine other than the one that built it, and notarising it is a separate
  step. See [packaging.md](packaging.md).
- **No delta updates.** Every update is the whole application.
- **No rollback.** The previous version is kept only until the next start.
- **The updater is a compile-time feature.** It is on by default; a runtime
  built without it answers `UNSUPPORTED` and is 0.9 MB smaller - 1.8 MB
  rather than 2.7 - since that is where the HTTP client and TLS live. Apps
  distributed through a store,
  which update themselves through the store, want it off.
