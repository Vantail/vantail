---
id: ADR-0003
title: Plugin security model
status: proposed
date: 2026-10-25
decision-makers:
  - Maintainer
---

# ADR-0003 — Plugin security model

## Context

[ADR-0002](ADR-0002-native-sidecar-plugins.md) proposes moving capabilities
out of the runtime into native plugin executables, talking to the runtime over
the protocol proposed in [ADR-0001](ADR-0001-runtime-managed-sidecar-ipc.md). The
maintainer's requirement is a **high security model for the plugin manager and
for plugins** - not a weaker one than a capability compiled into the runtime
has today.

Today the runtime enforces every permission itself, in-process: a page's call
is checked against deny-by-default scopes before anything happens
([permissions](../permissions.md)). A program the runtime starts is outside
all of that - it runs with the user's privileges and nothing follows it
([permissions](../permissions.md#a-program-you-start-is-outside-all-of-this)).
A plugin is such a program. Without a model of its own, moving SQLite into a
plugin would move it from "checked on every call" to "trusted with the
account".

What exists to build on: the runtime starts children with no shell and an
argument vector, can start them with an empty environment (`env_clear` in
`runtime/src/api/process.rs`), kills them when it exits, hands out its own
handle ids rather than OS pids, and verifies Ed25519 signatures for the
updater ([updater](../updater.md)).

## Threat model

What this defends against:

- **T1 — A hostile page.** Script injection or content from elsewhere drives a
  plugin beyond what the application meant to expose.
- **T2 — A hostile or compromised plugin.** A malicious package, a supply-chain
  substitution, or a bug in a plugin exploited through crafted input - trying
  to reach the user's files, the network, other plugins or the runtime.
- **T3 — Tampering with a plugin binary**, between publishing and packaging,
  or in an installed application.
- **T4 — Impersonation.** A plugin posing as another plugin or as the runtime,
  or pushing events the page did not ask for.
- **T5 — Denial of service.** A plugin that hangs, floods, crash-loops or
  exhausts memory.
- **T6 — Secrets in transit.** Keys (SQLCipher) or tokens passing through the
  webview, the environment or a command line.

Out of scope, as today: a compromised runtime binary or user account, and the
OS itself.

## Decision drivers

- Deny by default at every edge: page → plugin, plugin → page, plugin →
  runtime, plugin → OS.
- Least privilege per plugin: a plugin gets what its own declaration and the
  application's config grant it, not what the application has.
- The runtime is the only broker. Plugins have no channel to each other, to
  the webview, or to the network unless one is granted.
- Fail closed: when a protection cannot be applied, the plugin does not run.
- Nothing about it depends on the plugin being well-behaved.

## Considered options

### Option A — Plugins trusted like any child process

What `process.spawn` does today: gate the start, nothing after.

- Simplest; no platform work.
- A plugin bug is an account compromise (T2). Does not meet the requirement.

### Option B — Runtime-side gating only

Enforce T1, T3, T4, T5 and T6 in the runtime - declared methods, integrity
checks, limits - but no OS confinement.

- All of it portable and testable.
- T2 unanswered: a plugin can still open any file the user can. A database
  plugin with a parsing bug reads `~/.ssh`.

### Option C — Runtime-side gating plus an OS sandbox, fail closed (proposed)

Option B, and every plugin process starts inside an OS sandbox that confines
it to the resources granted to it. If the sandbox cannot be applied, the
plugin does not start, unless the application explicitly opts that plugin out.

- Answers T2 on the OS's own terms rather than by hoping.
- Significant per-platform work, and the mechanisms differ per OS (below).

### Option D — WebAssembly plugins only

- Sandboxed by construction.
- Cannot reach most of what native plugins exist for (see ADR-0002 option D).

## Proposed design (Option C)

1. **Declaration is consent.** Only plugins declared in `vantail.config.ts`
   start; installing a package grants nothing. The declaration names what the
   plugin is granted - directories, network hosts, runtime capabilities - and
   those grants are the plugin's own, never inherited from the application's
   permissions. *(T1, T2)*

2. **Page → plugin.** A page may call only methods that are both in the
   plugin's manifest and allowed by the application's config, and only from
   the application's own origin - the same origin rule every other call
   follows today. Parameters are size-limited by the runtime and validated by
   the plugin. *(T1)*

3. **Plugin → page.** A plugin may emit only events its manifest declares,
   size-limited, delivered through the runtime's existing push path, which
   reaches only the application's own origin. *(T4)*

4. **Plugin → runtime.** Nothing by default. A runtime capability a plugin
   needs - the OS keychain for a SQLCipher key, say - is declared in its
   manifest, granted in the config, and checked by the runtime exactly as a
   page call is, against the plugin's own grants. *(T2, T6)*

5. **Identity comes from the pipe.** The runtime knows which plugin a message
   came from by which process's stdout it arrived on. No message field can
   claim another identity, and there is no plugin-to-plugin channel. *(T4)*

6. **OS sandbox, fail closed.** Every plugin process is confined to its
   granted directories, with no network unless granted:
   - **Linux:** Landlock for the filesystem (kernel 5.13+) and, from ABI v4
     (kernel 6.7+), TCP; seccomp later to narrow system calls.
   - **macOS:** a Seatbelt profile applied at start, the mechanism Chromium
     and Firefox use for their helper processes.
   - **Windows:** an AppContainer, with access granted per directory, inside a
     job object.

   Where the sandbox cannot be applied - an older kernel, a failure - the
   plugin does not start, unless the config sets `sandbox: false` for that
   plugin, which `vantail doctor` and `vantail package` report. None of these
   mechanisms is proven in this codebase yet; see implementation step 1.
   *(T2)*

   **A plugin with its own JavaScript engine needs one thing a native plugin
   does not.** A JavaScript or TypeScript plugin brings its own Node or Bun
   ([ADR-0002](ADR-0002-native-sidecar-plugins.md)), and their engines
   compile code at run time - which the sandbox profile, and on macOS the
   plugin's code-signing entitlements, have to allow. That is a weaker
   profile, so it is not the default: a plugin declares that it needs it, and
   only a plugin that declares it gets it. *(T2)*

7. **Resources are brokered by the runtime.** A granted directory is resolved
   and checked by the runtime with the same path rules as `filesystem` scopes
   before the sandbox admits it. A database plugin gets a directory rather
   than a file, because SQLite creates `-wal`, `-shm` and `-journal` files
   beside the database; it also checks paths inside that directory itself, as
   a second line. *(T2)*

8. **Process hygiene.** An empty environment plus only variables the runtime
   defines; a working directory of the plugin's own; no inherited descriptors
   but its three pipes; its own process group (job object on Windows) so the
   whole tree dies with the runtime; and a protocol rule that a plugin exits
   when its stdin closes. *(T2, T5, T6)*

9. **Integrity, checked twice.** Each plugin binary's SHA-256 is pinned in the
   runtime config `vantail package` generates, which sits inside the signed
   application bundle. The runtime checks the hash before every start and
   refuses on a mismatch. Official plugins are also signed with a Vantail
   Ed25519 key, verified by the CLI at package time with the same code the
   updater uses. A plugin is never fetched at run time. How a plugin and its
   signature reach the developer is
   [ADR-0004](ADR-0004-plugin-distribution.md); these requirements bind
   whichever way is chosen. *(T3)*

10. **Limits.** A maximum message size, a bounded queue per plugin, a timeout
    per request, cancellation, and malformed messages dropped and counted. A
    plugin that crosses an error threshold is killed; restarts back off and
    stop after a limit; a crash fails its pending calls and tells the page.
    *(T5)*

11. **Secrets never cross the webview.** Key material goes from the OS
    keychain, through the runtime, to the plugin over its pipe - never through
    a page, an environment variable or a command line, which other processes
    can read. *(T6)*

12. **The HTTP opt-in stays confined.** A plugin allowed to serve a web page
    (ADR-0001) binds loopback only, is still sandboxed, and the page it serves
    is not the application's origin, so it gets no bridge. *(T1, T2)*

## Decision and rationale

Pending the maintainer's review. Option C is proposed as the only option that
meets the requirement: A and B leave T2 - a plugin with the user's whole
account - open.

## Consequences

- Positive: a plugin bug or a hostile plugin is confined to what it was
  granted; compromise of one plugin does not reach another; every grant is
  visible in the config.
- Negative/tradeoffs: three sandbox implementations to build and maintain,
  each with its own failure modes; minimum OS versions rise (Landlock needs
  Linux 5.13, network rules 6.7); plugins cannot reach a file the user picked
  unless that grant is extended to them (open question 3).
- Risks and mitigations:
  - **The macOS Seatbelt API is deprecated** though still used by major
    browsers - the prototype must confirm it works on every supported macOS
    release, and the alternative (an App Sandbox entitlement on the plugin
    binary) should be evaluated alongside.
  - **AppContainer needs access granted per directory**, which has to be
    undone cleanly.
  - **A sandbox that silently does nothing** is worse than none: every
    platform gets escape tests that must fail, in the integration suite.

## Open questions

1. **Third-party plugins.** Official only until the sandbox is proven on all
   three platforms, or from the start with a pinned hash? (Recommended:
   official only first.)
2. **Opting out of the sandbox.** Allowed at all, or only for the HTTP
   opt-in, or never?
3. **Dialog grants.** When the user picks a file, can the application extend
   that grant to a plugin - to open a database the user chose - and how?
4. **Signing keys.** Official plugins signed with a dedicated key, separate
   from anything else - where is it held, and how is it rotated?
5. **Minimum platform versions** the sandbox implies, and whether a platform
   below them is unsupported or runs plugins with `sandbox: false`.

## Implementation and validation

Not started. In order, each step ending in tests:

1. **Sandbox prototypes, per platform**, with an echo plugin that tries to
   read outside its grant (`~/.ssh`), write outside it, open a network
   connection, read the runtime's environment, and spawn a child. Every
   attempt must fail. These become the integration suite's escape tests - the
   same kind of test that found the filesystem holes fixed alongside this.
   Run twice: once with a native echo plugin, and once with the same plugin
   as a compiled Bun (or Node) binary - to prove that a JavaScript engine
   runs inside the sandbox at all, and that granting it run-time code
   generation opens nothing else.
2. **Integrity:** hash pinning and a tamper test (a modified binary refuses to
   start).
3. **Protocol robustness:** malformed, oversized and flooding messages; a
   plugin that never answers; one that exits mid-call.
4. **Only then** the SQLite plugin from ADR-0002, on top of all of the above.

## Related documents

- [Permissions](../permissions.md)
- [Updater](../updater.md)
- [ADR-0001 — Runtime-managed sidecars over a JSON-RPC stdio protocol](ADR-0001-runtime-managed-sidecar-ipc.md)
- [ADR-0002 — Optional native capabilities as sidecar plugins](ADR-0002-native-sidecar-plugins.md)
- [ADR-0004 — How plugins are distributed](ADR-0004-plugin-distribution.md)

<!-- Accepted decisions are preserved. To replace one, create a new ADR and link supersession in the index or metadata. -->
