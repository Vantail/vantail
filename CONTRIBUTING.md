# Contributing

## Getting set up

```bash
pnpm install
pnpm build            # the TypeScript packages
pnpm build:runtime    # cargo build --release
pnpm test             # Rust tests, package tests, integration tests
```

The examples run against that local build, so there is nothing to publish and
nothing to configure:

```bash
cd examples/react
node ../../packages/cli/dist/bin.js dev
```

`@vantail/runtime` falls back to `target/{release,debug}/vantail-runtime` when
no platform package is installed, which is what makes that work. `vantail
doctor` prints which runtime it found.

[`examples/showcase`](examples/showcase) has a panel for every API, which is
usually the fastest way to try a change by hand.

## Ways of working

**Tests come with the change.** The suite is the reason a release can go out
without a manual pass over five platforms, so it is worth keeping honest. Rust
tests live beside the code; the JavaScript packages have their own tests under
`packages/*/test`; anything that needs a real window belongs in
`test/integration`.

**One version across everything.** The runtime and the TypeScript packages
share a version number, because the runtime and the SDK have to agree about
the protocol between them.

```bash
node scripts/version.mjs patch    # 0.1.0 -> 0.1.1
node scripts/version.mjs --check  # fail if anything disagrees
```

Changing something that ships without moving the version fails the check,
which is cheaper than a release that stops half way.

**Comments say why.** What the code does is already in the code. A comment
earns its place by explaining a constraint that is not visible: a platform
that behaves differently, an ordering that matters, a simpler approach that
was tried and did not work.

**Permissions are deny-by-default.** A new capability starts unavailable and
has to be asked for in the config. Anything that widens what an application
can reach without the config saying so is a bug, however convenient.

## Adding an API

A call crosses four places, and missing one is the usual reason something
half-works:

1. `runtime/src/api/` - the implementation, and its permission check.
2. `packages/api/src/` - the typed wrapper the application imports.
3. `packages/shared/src/config.ts` - the permission, if it needs one.
4. `docs/api.md` - what it does, what it returns, what it can fail with.

## Testing on Linux

```bash
scripts/linux/run            # build, then the whole suite
scripts/linux/run shell      # a prompt inside the container
```

The container brings its own virtual display and window manager. The window
manager is not optional: maximising is something a window manager does, and
without one a window never changes size.

## Building the runtime for other platforms

```bash
scripts/build-platforms
```

macOS natively and both Linux architectures in containers, from one Mac with
Docker. Windows needs Windows.

## Releases

A tag publishes that version as `latest`. A push to `main` that changes
something shippable publishes a prerelease under the `dev` tag, so `main` is
installable without waiting for a release.

```bash
node scripts/version.mjs patch
git commit -am "Release 0.1.6"
git tag -a v0.1.6 -m "Release 0.1.6"
git push --follow-tags
```

The tag has to be annotated. `git push --follow-tags` ignores lightweight
ones, so `git tag v0.1.1` without `-a` pushes the commit, skips the tag, and
starts nothing. `git push origin v0.1.1` sends either kind.

Both channels come from `.github/workflows/release.yml`, which builds the
native runtimes on their own platforms and publishes with
[npm trusted publishing], so no credential is stored anywhere.

One thing that cannot be automated: a package's **first** publish. Trusted
publishing is configured per package on a settings page that only exists once
the package does, and a brand-new name cannot be staged either. So a new
package is published once from a logged-in session with a 2FA challenge, and
a trusted publisher is added to it afterwards. Everything from then on is
automatic.

[npm trusted publishing]: https://docs.npmjs.com/trusted-publishers
