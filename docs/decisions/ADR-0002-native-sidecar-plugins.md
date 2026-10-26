---
id: ADR-0002
title: Optional native capabilities as sidecar plugins, starting with SQLite
status: proposed
date: 2026-10-25
decision-makers:
  - Maintainer
---

# ADR-0002 — Optional native capabilities as sidecar plugins, starting with SQLite

## Context

Every native capability is compiled into the runtime and gated by a Cargo
feature. The default build includes all of them; the only other published
variant is SQLCipher, because its crypto adds 3.19 MB
([architecture](../architecture.md#what-encryption-costs-measured)). SQLite is
the largest optional capability in the default build at +885 KB
([architecture](../architecture.md#why-sqlite-is-bundled-and-why-it-is-on-by-default)),
on a runtime of 4.3 MB that is 2.1 MB with everything optional off.

The README states the trade the project made: the runtime is precompiled and
"there is no native command to add - what the runtime exposes is what you
get". An application that needs something the runtime does not have has no
way to add it except a sidecar it manages itself.

A proposal written this week (not in the repository) argues for one small
core plus optional native plugins, each a separate executable speaking the
protocol in [ADR-0001](ADR-0001-runtime-managed-sidecar-ipc.md), with SQLite
extracted first.

This ADR depends on ADR-0001 being accepted.

## Decision drivers

- **Runtime size and variants.** Optional capabilities should not cost every
  application, and SQLCipher should not need its own runtime build.
- **Extensibility without recompiling the runtime** - the reversal of the
  README's stated trade, and the reason this is a decision rather than a
  refactor.
- **The security model must not weaken.** Today the runtime checks every
  database path against `filesystem` scopes; a plugin process is not subject
  to them. Hardening of those checks against symlinks is in progress (not yet
  merged), and a plugin would not inherit that either.
- **The developer API stays familiar.** `database.*` already handles 64-bit
  integers exactly, transactions and snapshots
  ([architecture](../architecture.md#why-sqlite-is-bundled-and-why-it-is-on-by-default)).
- **Self-contained applications.** Nothing downloaded at run time.

## Considered options

### Option A — Keep capabilities compiled in, gated by features

- No new moving parts; in-process calls; one permission model.
- Only SQLCipher needs a second published runtime today, so the variant
  problem is small. Extensibility stays impossible by design.

### Option B — Native sidecar plugins, SQLite first (proposed)

Each plugin is a separate executable with a manifest (id, version, protocol
version, methods, platform binaries, integrity hashes), declared explicitly
in `vantail.config.ts` and bundled by `vantail package`. How it is
published and installed is a separate decision,
[ADR-0004](ADR-0004-plugin-distribution.md). The runtime registers,
starts, supervises and routes to plugins; it knows nothing about what a
plugin does.

A plugin can be written in any language, because to the runtime it is only
an executable that speaks the protocol. A JavaScript or TypeScript plugin
brings its own runtime: its author chooses Node or Bun and builds it into the
plugin - a compiled Bun binary, a Node single executable - the way
`examples/chat` already ships its server as a sidecar. Vantail provides no
JavaScript runtime of its own, so there is one kind of plugin to start,
sandbox and supervise, whatever it was written in.

- Removes SQLite (and the SQLCipher variant) from the runtime.
- Gives applications a way to add native capabilities.
- Every call gains a process hop (page → runtime → plugin); unmeasured.
- An application that uses SQLite ships a plugin executable as well, so its
  total size may grow; only applications that do not use it get smaller.
- The plugin has the user's OS privileges; the runtime can gate calls to it
  but cannot confine what it does.

### Option C — In-process dynamic libraries

Plugins loaded into the runtime as shared libraries.

- No process hop.
- A crashing or malicious plugin takes the runtime with it; ABI stability
  across Rust versions is not guaranteed; signing and notarisation get
  harder. Not evaluated further.

### Option D — Plugins in WebAssembly

- Sandboxed by construction and portable.
- Cannot reach most of what native capabilities exist for (devices, OS
  services) without host functions the runtime would have to provide - which
  is option A again. Not evaluated further.

## Decision and rationale

Pending. **Option B is proposed**, and it matches the direction the
maintainer has stated (2026-10-25): Vantail moving towards a slim runtime,
with functionality added through native plugins rather than compiled in, and
SQLite one of the first plugins.

It is the only option that both shrinks the runtime and lets applications add
capabilities, and it builds on ADR-0001 rather than adding a second mechanism.
The cost is real - a security boundary that the runtime alone no longer holds,
and a hop per call. The first is answered by a security model the plugin
manager and every plugin are held to, in
[ADR-0003](ADR-0003-plugin-security-model.md); the second is measured before
anything is removed from the runtime.

This reverses the trade the README states ("there is no native command to
add"). The README changes when plugins ship, not before - it describes what
exists.

## Consequences

- Positive: a smaller default runtime; no SQLCipher runtime variant; a path
  for capabilities the runtime will never ship itself.
- Negative/tradeoffs: per-call latency for database work; more packages to
  build, sign and publish per platform; two places (runtime and plugin) that
  must agree on a protocol version.
- A JavaScript plugin carries its runtime, and that is most of its size:
  measured on macOS arm64, Bun 1.0.1 is 48.2 MB and a compiled Bun sidecar
  (`examples/chat`) 48.3 MB; the Node 24 binary a single executable is built
  from is 113.6 MB. Each such plugin adds that much to the application,
  per platform - the plugin author's choice, but one the archive format has
  to allow for (the `.van` format currently caps a single file at 64 MiB,
  which a Node-based plugin exceeds).
- Risks and mitigations:
  - **Path checks move out of the runtime**, and **plugins run with the
    user's privileges**. Both are what [ADR-0003](ADR-0003-plugin-security-model.md)
    is for.
  - **SQLCipher keys must never pass through the webview.** Covered in
    ADR-0003.
  - **Migration.** Existing applications use built-in `database.*`; both
    implementations should run the same test suite, including opening files
    the other created, before the built-in one is removed.

## Open questions

Whether to have native extensibility at all is the decision this ADR records;
the maintainer's stated direction is yes. Trust in third-party plugins and
where file scopes are enforced moved to
[ADR-0003](ADR-0003-plugin-security-model.md). Also open here:

1. **Is a process hop per query acceptable?** Needs measuring against today's
   in-process `database.*` - single queries, batched inserts, transactions.
2. **Compatibility window.** How long do built-in `database.*` and the plugin
   coexist, and is the public API kept identical?
3. **Which capabilities follow SQLite?** mDNS and HID are self-contained
   candidates; windows, dialogs and the bridge stay in the runtime.

## Implementation and validation

Not started. Needs ADR-0001's protocol and ADR-0003's security model first.
Suggested order:

1. A plugin host with an echo plugin, on ADR-0001's protocol, held to
   ADR-0003 from its first version.
2. The current database code extracted unchanged into a plugin executable,
   with both implementations passing the existing database tests.
3. Measurement of question 4 before anything is removed from the runtime.
4. Packaging: per-platform binaries, integrity check, bundling and signing,
   in whatever form [ADR-0004](ADR-0004-plugin-distribution.md) decides.
5. Only then: remove `database` from the runtime and its features, and add
   SQLCipher as a separate plugin.

## Related documents

- [Architecture](../architecture.md)
- [Permissions](../permissions.md)
- [ADR-0001 — Runtime-managed sidecars over a JSON-RPC stdio protocol](ADR-0001-runtime-managed-sidecar-ipc.md)
- [ADR-0003 — Plugin security model](ADR-0003-plugin-security-model.md)
- [ADR-0004 — How plugins are distributed](ADR-0004-plugin-distribution.md)

<!-- Accepted decisions are preserved. To replace one, create a new ADR and link supersession in the index or metadata. -->
