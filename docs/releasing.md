# Releasing

Two things ship on different tracks: the TypeScript packages, and the runtime
binaries they download.

## The runtime binaries

The promise Vantail makes is that an application developer never compiles Rust.
That works because the runtime is published as a set of platform packages,
each containing one executable:

```text
@vantail/runtime-darwin-arm64/bin/vantail-runtime
@vantail/runtime-win32-x64/bin/vantail-runtime.exe
@vantail/runtime-win32-arm64/bin/vantail-runtime.exe
@vantail/runtime-linux-x64/bin/vantail-runtime
@vantail/runtime-linux-arm64/bin/vantail-runtime
```

The target list lives in [`packages/runtime/platforms.json`](../packages/runtime/platforms.json)
with the Rust triple for each, and a `tier` saying how well tested it is.

Each package declares `os` and `cpu` so npm installs only the one that
matches. Applications depend on them as optional dependencies, which is why
`npm install` downloads one binary and not five.

Build them with:

```bash
cargo build --release --locked --target <triple>
```

### Building them without CI

```bash
scripts/build-platforms          # three of the five, into dist-runtime/
```

macOS natively and both Linux architectures in containers, from a Mac with
Docker. Windows needs Windows, so a full release still goes through the
workflow.

Every target gets a **native runner** rather than cross-compilation, because
the runtime links against the platform's webview, tray and HID libraries and
cross-compiling those is a source of problems nobody needs on a release day.
`.github/workflows/release.yml` has the matrix; a test asserts it covers
exactly the targets in `platforms.json`, since a target missing from one of
the two fails a release halfway through, after packages are already on the
registry.

## Cutting a release

```bash
node scripts/version.mjs 0.2.0     # one version, nine files
git commit -am "Release 0.2.0"
git tag v0.2.0 && git push --follow-tags
```

The tag starts `release.yml`, which builds all five runtimes on native
runners, smoke-tests each binary, packages them, and publishes. The tag has to
match `package.json` or the publish job stops before sending anything.

## The dev channel

`release.yml` also runs on every push to `main`, and publishes a prerelease of
the next patch under the `dev` tag: `0.1.1-dev.<run number>`. The version sorts
above the last release and below the next one, and `latest` is never moved by a
push.

Both channels live in the one file because npm allows a package exactly one
trusted publisher, bound to an exact workflow filename. A second workflow
publishing dev builds would need a token of its own, which is the thing this
setup does not have.

A dev build publishes the TypeScript alone, against the binaries the last
release published, so a push to `main` never pays for five native builds. Three
things make that impossible, and each skips the run with a warning rather than
failing it, because none of them is a fault in the commit that triggered it:

- there is no release tag yet, so there are no binaries to point at;
- the Rust has moved since that tag, so the binaries are the wrong ones;
- nothing that ships changed in the push.

To rehearse without publishing, run the workflow by hand with `dry_run`
enabled - or locally:

```bash
node scripts/build-platform-packages.mjs --binaries dist-runtime --out dist-packages
node scripts/publish.mjs --dry-run --packages dist-packages
```

Publishing order matters and is enforced by a test: the platform binaries go
first, because `@vantail/runtime` declares optional dependencies on them and
npm resolves those at install time. Those optional dependencies are injected
at publish time rather than committed - in the repository they would point at
versions that do not exist yet, and `pnpm install` would fail.

## Credentials

There are none. Packages go to npmjs under the `@vantail` scope using [trusted
publishing]: at publish time npm exchanges an OIDC token minted by this
workflow for a short-lived registry token. Nothing long-lived is stored, and
there is no secret to rotate or leak.

What that depends on, all of which a test asserts:

- `id-token: write` on the publish job, which is what allows minting the OIDC
  token.
- npm 11.5.1 or newer. The Node this job sets up still ships npm 10, so the
  workflow upgrades it explicitly.
- No `_authToken` anywhere. An auth line takes precedence over the exchange,
  so the `.npmrc` the workflow writes carries the registry and nothing else.
- The `repository` field in each `package.json` matching this repository,
  which is also what provenance is checked against.

`publish.mjs` refuses npmjs unless told to go ahead, because a publish there
cannot be undone; the workflow passes `--i-mean-it-publish-publicly` to say so.

Packages are published with [npm provenance], so anyone can verify they were
built from this repository by this workflow. `publish.mjs` asks for it only on
CI: npm can only attest from an environment it recognises, and asking anywhere
else is a hard error, which would otherwise break the one publish that has to
happen by hand.

### Adding a package

A package's **first** publish cannot be automated. Not by any route: npm has
closed all of them, deliberately.

- Trusted publishing needs the package to exist, because the trusted publisher
  is configured on a settings page that only appears once it does.
- [Staged publishing] does not fill the gap either. You cannot stage a package
  that does not exist.
- Tokens that bypass 2FA lose the ability to publish in January 2027, and npm
  no longer hands them out freely.

So a new name is created once, from a logged-in session, by a person answering
a 2FA challenge:

```bash
npm login
node scripts/publish.mjs --packages dist-packages --i-mean-it-publish-publicly
```

npm asks for a one-time password in the terminal, and more than once, since an
OTP expires faster than a set of tarballs uploads. `publish.mjs` runs npm with
`stdio: "inherit"` so the prompt arrives rather than the process hanging on it.
This is also the reason provenance is asked for only on CI: npm refuses to
attest from a laptop, and that refusal is fatal rather than a warning.

Then, on npmjs, under the package's Settings, add a trusted publisher: the
`Vantail/vantail` repository and `release.yml` as the workflow. One entry
covers both channels, since both publish from that file.

At the first release that is eleven packages: the six under `packages/`, and
the five platform packages named in
[`platforms.json`](../packages/runtime/platforms.json). Afterwards it is one
package at a time, and only when a name is genuinely new - a new platform
target, or a new `@vantail/*`. Nothing else ever needs a human.

[Staged publishing]: https://docs.npmjs.com/staged-publishing/

[trusted publishing]: https://docs.npmjs.com/trusted-publishers
[npm provenance]: https://docs.npmjs.com/generating-provenance-statements

## How the binary is found

[`@vantail/runtime`](../packages/runtime) resolves in this order:

1. `$VANTAIL_RUNTIME_BIN` - an explicit path. For CI, and for anyone hacking on
   the runtime.
2. `@vantail/runtime-<platform>-<arch>` - resolved from the project first,
   then from the CLI's own location, so an app can pin a runtime version that
   differs from its CLI.
3. `target/release/vantail-runtime`, then `target/debug` - found by walking up
   for the Cargo workspace. This is what makes the examples in this repository
   run before anything is published.

`vantail doctor` prints which one was used.

## Version alignment

The runtime reports its version to the SDK as `runtimeVersion()`, and the
`vantail.json` it reads is generated by the CLI. Those two need to agree about
the protocol, so the runtime packages are versioned in lockstep with the
TypeScript packages: one version number across the whole repository.

## Installers

```bash
vantail package --installer
```

| Platform | Format | How                                                             |
| -------- | ------ | --------------------------------------------------------------- |
| macOS    | `.dmg` | `hdiutil`, with an Applications alias to drag onto              |
| Windows  | `.msi` | A generated `.wxs`, built by WiX                                |
| Linux    | `.deb` | Written directly - `ar` plus two tarballs, no `dpkg-deb` needed |

Each is built on its own platform, because the bundle it wraps can only be
produced there anyway.

The `.deb` is assembled by hand rather than shelled out to `dpkg-deb` so that
a Linux package can be cut from any machine. It installs into
`/usr/lib/<name>` with a launcher in `/usr/bin`, a `.desktop` entry, and icons
at every hicolor size.

The `.msi` needs WiX, which is a dotnet tool and only runs on Windows:

```powershell
dotnet tool install --global wix
```

Without it, `--installer` writes the `.wxs` and tells you that command rather
than reporting a failure.

## Signing

`vantail package` applies an ad-hoc signature on macOS, which is enough to
launch on the machine that built it. Shipping to other people needs a
Developer ID identity:

```bash
vantail package --sign "Developer ID Application: Jane Doe (ABCDE12345)"
```

Notarisation is not automated yet - run `xcrun notarytool` against the bundle
afterwards.

Windows code signing and Linux packaging (`.deb`, AppImage) are not covered
by `vantail package` yet.
