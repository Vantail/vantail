# Distribution

Getting one application onto macOS, Windows and Linux.

[docs/packaging.md](packaging.md) covers what `vantail package` produces on the
machine you run it on. This covers the part after that: producing all of them,
from one tag, without owning three computers.

## There is no cross-compilation

`vantail package` builds for the machine it runs on and nothing else. That is
not a gap waiting to be filled - each installer is made by tooling that only
exists on its own platform:

| Platform | Installer | Built by                              |
| -------- | --------- | ------------------------------------- |
| macOS    | `.dmg`    | `hdiutil`, which is macOS only        |
| Windows  | `.msi`    | WiX, a dotnet tool that runs on Windows |
| Linux    | `.deb`    | written directly, so any Linux runner |

Code signing has the same shape: a Developer ID identity lives in a macOS
keychain, and notarisation talks to Apple from a Mac.

So a release is one job per operating system. The scaffolder gives you that
workflow already.

## Which platforms you can ship to

The runtime is published for five targets, and an application can only run
where there is a runtime:

| Target         | Tier | Notes                                    |
| -------------- | ---- | ---------------------------------------- |
| `darwin-arm64` | 1    | Apple Silicon. **There is no Intel build.** |
| `win32-x64`    | 1    |                                          |
| `win32-arm64`  | 2    |                                          |
| `linux-x64`    | 2    |                                          |
| `linux-arm64`  | 2    |                                          |

Tier 1 is exercised on every change; tier 2 is built and smoke tested. The
list lives in
[`packages/runtime/platforms.json`](../packages/runtime/platforms.json), which
is what the release pipeline builds from - so it is the list, not a copy of it.

**Intel Macs are worth planning around.** `@vantail/runtime-darwin-x64` does
not exist, so an Intel Mac cannot install your application at all. `vantail
doctor` says so by name, and `npm create @vantail` refuses before writing
anything, but neither helps a user who has already downloaded a `.dmg`. Say so
on your download page.

## The workflow you get

A scaffolded project ships `.github/workflows/release.yml`. Tag a version and
it runs:

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push --follow-tags
```

`--follow-tags` ignores lightweight tags, so `git tag v0.1.0` without `-a`
pushes the commit, skips the tag, and starts nothing.

It builds three jobs in parallel, uploads each installer as an artifact, and
attaches all of them to a **draft** release. Draft on purpose: you get to look
at what three machines produced before anyone can download it.

Two details in it that are easy to get wrong on your own:

- **`fail-fast: false`.** Without it, one platform failing cancels the other
  two and throws away installers that built correctly.
- **WiX is installed explicitly on Windows.** Without it, `--installer` writes
  the `.wxs` and *tells* you rather than failing - so the job would go green
  with no `.msi` in it.

Linux also needs the WebKitGTK runtime libraries, which the workflow installs.
The webview is always the operating system's own; that is why the bundles are
small and why Linux needs a package the other two do not.

## Signing

Unsigned, an application runs on the machine that built it and warns or
refuses elsewhere. What each platform wants:

**macOS.** A Developer ID identity, then notarisation:

```bash
vantail package --installer --sign "Developer ID Application: Jane Doe (ABCDE12345)"
xcrun notarytool submit build/MyApp-1.0.0.dmg --keychain-profile "AC" --wait
xcrun stapler staple build/MyApp-1.0.0.dmg
```

In CI, import the identity into a temporary keychain from a base64 secret
rather than checking a `.p12` into the repository.

**Windows.** `.msi` signing is not wired into `vantail package`. Sign the
installer after the fact with `signtool`, from a certificate in the runner's
store or an HSM-backed service.

**Linux.** `.deb` files are not usually signed; the repository that serves them
is. Publishing to a GitHub release, as the workflow does, is the common case
and needs nothing.

Signing is the one part worth doing before the first public release rather
than after. Users who have already installed an unsigned build get a different,
worse prompt when a signed one replaces it.

## Updates

Shipping a second version is [docs/updater.md](updater.md). The short of it:
the same per-platform jobs also produce `<App>-<version>-<target>.tar.gz` when
you pass `--update`, and `vantail updater manifest` signs one document naming
every target. Target keys there use Rust's spelling - `darwin-aarch64`, not
`darwin-arm64`.

If you expect to ship updates, generate the signing key before the first
release. The key is what proves a later bundle is yours, and it cannot be
added retroactively to an application already installed.
