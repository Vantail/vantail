---
id: ADR-0004
title: How plugins are distributed
status: proposed
date: 2026-10-26
decision-makers:
  - Maintainer
---

# ADR-0004 — How plugins are distributed

## Context

[ADR-0002](ADR-0002-native-sidecar-plugins.md) proposes plugins as separate
executables, and [ADR-0003](ADR-0003-plugin-security-model.md) sets the
security they are held to. Neither decides how a plugin gets from its author
into an application, and two sources describe that differently:

- The proposal behind ADR-0002 (not in the repository) ships plugins as **npm
  packages**: a package with the TypeScript API, plus per-platform packages
  with the binaries.
- The `Vantail/van`, `Vantail/van-pkg` and `Vantail/van-pack` repositories
  describe **signed `.van` archives**, distributed through an official plugin
  repository and installed by `van-pkg`. As of 2026-10-26 the format
  specification (`van/SPEC.md`, format version 1) exists; `van-pkg` has no
  code; `van-pack` has an implementation in an open pull request, not merged.

How the runtime itself ships today is the nearest precedent: one npm package
per platform (`@vantail/runtime-<platform>-<arch>`, and a `-sqlcipher`
variant), declared as optional dependencies of `@vantail/runtime` with `os`
and `cpu` set, so a package manager installs only the one for the current
machine ([packaging](../packaging.md)). They are published from CI with npm
trusted publishing, so no credential is stored
([contributing](../../CONTRIBUTING.md)).

A plugin has two parts that may travel differently:

- **The executable** - native code, or a compiled Bun or Node binary
  (ADR-0002) - one per platform, run by the runtime inside a sandbox.
- **The TypeScript API** the application's page imports, such as
  `database.open()`. Plain JavaScript, bundled by the application's build
  (Vite), with no native code.

This decision needs discussion before anything is built; the questions below
are the agenda.

## Decision drivers

From ADR-0003, binding on every option:

- **Nothing is fetched at run time.** A plugin is in the application bundle
  when it is installed by the user.
- **Official plugins carry a Vantail signature**, verified before a plugin is
  bundled, and the runtime checks the bundled binary's pinned hash before
  every start.
- **No code runs when a plugin is installed** - no install scripts.

Weighed between the options:

- **Signer authenticity, not only integrity.** A registry checksum proves the
  bytes were not altered on the way; it does not prove who published them. A
  signature by a key Vantail controls does.
- **Developer experience.** One install step; types in the editor; works with
  pnpm, npm and Vite as they are.
- **Reproducible and offline builds.** CI and a developer's machine get the
  same plugin bytes, and a build does not need the network once dependencies
  are installed.
- **Infrastructure cost.** A plugin repository of Vantail's own is hosting,
  availability, abuse handling and takedowns to run.
- **A path to third-party plugins** later, without redesigning distribution.
- **Version coupling.** The TypeScript API and the executable must be the
  same release.

## Considered options

### Option A — npm only

The TypeScript API and the per-platform executables are npm packages, like
the runtime today. `pnpm add @vantail/plugin-sqlite`; `vantail package` finds
the right binary.

- Familiar; matches the runtime's own distribution; no new tools or hosting.
- Trust rests on whoever controls the npm account and the publishing
  pipeline. npm provenance attests where a package was built, not that
  Vantail approved it.
- Install scripts must be prevented by policy (`--ignore-scripts`), not by
  construction.
- `van`, `van-pkg` and `van-pack` are not needed.

### Option B — `.van` only

The executable and the TypeScript API travel in a signed `.van`, fetched from
a Vantail plugin repository by `van-pkg`.

- Signer authenticity by construction; one artifact per release.
- The TypeScript API arrives outside npm, which the application's bundler and
  editor do not expect - it would have to be unpacked somewhere they look.
- A plugin repository to host and run.

### Option C — Split: TypeScript API on npm, executable as a signed `.van`

The API is an ordinary npm package. The executable is a signed `.van`, which
`van-pkg` fetches at build time and pins in a lockfile; `vantail package`
verifies it again and bundles the extracted binary.

- Signer authenticity for the part that runs natively; npm for the part the
  bundler already understands.
- Two artifacts per release, two tools to install with, and a version match
  to enforce between them.
- A plugin repository to host and run, or another host for `.van` files.

### Option D — Signed `.van` inside npm packages

npm delivers everything, but what it delivers for the executable is a signed
`.van` (one per platform, in per-platform packages as the runtime does), not a
bare binary. `pnpm add` installs it; `vantail package` verifies the signature
and hashes before bundling.

- One install step, no plugin repository to host, and still a Vantail
  signature on what runs natively - verified by Vantail's own tooling, not
  trusted from npm.
- `van-pkg` shrinks to a verifier, or into `vantail package`; `van-pack`
  stays as the tool that builds and signs the archives.
- Third-party plugins would arrive the same way, so their trust rules (signed
  by whom) cannot lean on the channel.

## Questions for discussion

1. **Artifacts.** One artifact per release or two? One `.van` per platform or
   one holding every platform? How are the TypeScript API and the executable
   tied to the same version, and what checks it?
2. **Source and hosting.** The npm registry, a Vantail-run repository, GitHub
   releases? Who runs it, and what happens when it is down or a package has to
   be taken down?
3. **Installing.** Which command does a developer run? Where do the files live
   in a project - fetched into a cache, or committed? What is the lockfile,
   and does a CI build need anything but it?
4. **Keys and trust.** Where is the plugin signing key held (hardware key, CI
   with OIDC), and who can use it? How do Vantail's tools learn the trusted
   public keys - built into the CLI, shipped separately? How are keys rotated
   and revoked, and how does a revocation reach developers who already
   installed a plugin?
5. **Into the application.** When is the signature verified - on install, on
   `vantail package`, both? What does `vantail package` do on macOS (re-sign
   the plugin binary with the application's identity, notarise it), on
   Windows (Authenticode), on Linux (`.deb`)?
6. **Updates.** How does a developer learn about and take a plugin update - a
   security fix in particular? Are versions yanked or marked unsafe, and how?
7. **Developing a plugin.** How does a plugin author use an unpublished,
   unsigned build in an application while working on it, without that path
   reaching a packaged application?
8. **Third-party plugins.** The same channel as official ones or a separate
   one? Name squatting and impersonation of official names? Any review?
9. **The `van` repositories.** Under the chosen option, what is each of
   `van`, `van-pkg` and `van-pack` for, and what changes in `van/SPEC.md`?

## Decision and rationale

Pending - to be discussed. No option is chosen.

## Consequences

Depend on the option chosen. What each would mean for the existing work:

| | `van/SPEC.md` | `van-pkg` | `van-pack` | `vantail package` |
| --- | --- | --- | --- | --- |
| A | Not needed | Not needed | Not needed | Resolves npm binaries, checks pinned hashes |
| B | Carries the TypeScript API too | Fetches from the repository | Builds and signs | Verifies and extracts |
| C | Executable only | Fetches `.van`, keeps the lockfile | Builds and signs | Verifies and extracts |
| D | Executable only | A verifier, or merged into the CLI | Builds and signs | Verifies and extracts |

## Implementation and validation

Not started, and not to start until this is decided. Whatever is chosen
should be proven with the SQLite plugin from ADR-0002 end to end: published,
installed into an application, packaged, signature and hash checked, started
by the runtime - and a tampered archive and a revoked key both refused.

## Related documents

- [Packaging](../packaging.md)
- [ADR-0002 — Optional native capabilities as sidecar plugins](ADR-0002-native-sidecar-plugins.md)
- [ADR-0003 — Plugin security model](ADR-0003-plugin-security-model.md)
- `Vantail/van` (`SPEC.md`), `Vantail/van-pkg`, `Vantail/van-pack` on GitHub

<!-- Accepted decisions are preserved. To replace one, create a new ADR and link supersession in the index or metadata. -->
