---
id: ADR-0001
title: Runtime-managed sidecars over a JSON-RPC stdio protocol
status: proposed
date: 2026-10-25
decision-makers:
  - Maintainer
---

# ADR-0001 — Runtime-managed sidecars over a JSON-RPC stdio protocol

## Context

A sidecar is a program shipped inside the application bundle and started at
run time. Today the runtime treats it like any other child process: the page
starts it with `process.spawn`, and whatever happens after that is the
application's own design. The runtime already provides the primitives -
spawning a program on the `shell.allow` list, writing to its stdin
(`process.write`, `process.closeStdin`), streaming its stdout and stderr back
to the page as events, and killing it - and it already kills children when it
exits ([architecture](../architecture.md#processes),
[api](../api.md)).

The one sidecar example, `examples/chat`, uses loopback HTTP: the sidecar
announces a port on stdout and the page talks to it over `http://127.0.0.1`.
That runs into the runtime's origin trust. Since 0.1.26 the bridge is only
given to the application's own origin (and the dev server in development), so
a page that navigates to the sidecar loses the bridge entirely - which is
what the packaged chat example does, so it currently draws its title bar
under the window buttons and cannot be dragged. A rework in progress (not yet
merged) keeps the page in the bundle and sends only its requests to the
sidecar. That works, but needs CORS, an origin check in the sidecar and a
narrowed htmx configuration - and a loopback port is reachable from every
website in the user's browser, so the sidecar has to defend itself.

Two proposals written this week (not in the repository) argue that sidecars
should be first-class managed components with a protocol the runtime owns,
and that native plugins should be built on it
([ADR-0002](ADR-0002-native-sidecar-plugins.md)).

## Decision drivers

- **Trust stays with the runtime.** The page should not need a network port to
  reach the application's own backend, and a backend should not need to
  defend a port against the rest of the machine.
- **Language independence.** Sidecars may be Bun, Node, Rust, C# or Go; the
  contract cannot be a JavaScript runtime's own messaging.
- **No new heavy dependencies** in a runtime whose size is measured and
  documented.
- **The event loop never blocks.** Process I/O stays on its own threads, as it
  does today ([architecture](../architecture.md#threading)).
- **Identity comes from the runtime.** Which sidecar sent a message is known
  from the pipe it arrived on, never from a field the sidecar fills in.

## Considered options

### Option A — Keep the status quo: the page talks to sidecars itself

Over loopback HTTP, as `examples/chat` does, or over stdio using the existing
`process.*` API with framing done in JavaScript.

- No runtime change at all; stdio from the page already works today.
- Every application reinvents framing, request ids, timeouts and readiness.
- Sidecar identity, lifecycle and permissions stay entirely in application
  code. HTTP additionally exposes a port to the machine.

### Option B — Runtime-managed sidecars over stdio, JSON-RPC 2.0 (proposed)

The runtime starts declared sidecars, owns their stdin/stdout, frames
messages as newline-delimited JSON-RPC 2.0, routes calls and responses by id,
and delivers sidecar notifications to the page as events. stderr stays logs.

- Uses what `process.rs` already does (spawn, pipes, reader threads, kill on
  exit); adds framing, correlation, timeouts and a declared-sidecar registry.
- Language independent; JSON-RPC over stdio is what LSP and local MCP servers
  use.
- No port, so nothing outside the process tree can reach the sidecar.
- One parent per pipe: a sidecar cannot be shared between applications or
  reconnected to - not needed for anything in scope.

### Option C — Unix domain sockets and Windows named pipes

A private OS endpoint per sidecar.

- Allows reconnecting and independently started services.
- Needs per-platform transports and connection authentication from the start,
  for capabilities nothing here needs yet. Kept as a later transport behind
  the same protocol.

### Option D — gRPC / Protocol Buffers

- Typed contracts and streaming.
- Code generation and runtime dependencies in every language a sidecar is
  written in, and in the runtime. Disproportionate for the call volume here.

### Option E — Node/Bun built-in process messaging

- Ruled out by language independence: it is a JavaScript-runtime contract.

## Decision and rationale

Pending. **Option B is proposed**, and it matches the direction the
maintainer has stated (2026-10-25): no HTTP between the runtime and plugins by
default. The runtime would manage its sidecars and plugins and talk to them
over JSON-RPC 2.0 on stdio. It closes the trust problem HTTP creates, reuses
machinery the runtime already has, adds no dependency, and does not tie
sidecars to one language. The transport sits behind an interface so Option C
can be added later without changing the protocol.

**No HTTP by default.** The runtime would not talk to a plugin over HTTP, and
a plugin would not listen on a port, unless the application explicitly decides
it should - the case in mind is a plugin that serves a web page. That would be
an opt-in per plugin, declared in the config, never a default. A page served
that way is not the application's own origin, so it gets no bridge, exactly as
today.

Plugins are the main consumer of this protocol - see
[ADR-0002](ADR-0002-native-sidecar-plugins.md) - and they are held to the
security model in [ADR-0003](ADR-0003-plugin-security-model.md).

## Consequences

- Positive: no loopback port for runtime-managed sidecars; framing, ids,
  timeouts and lifecycle written once; sidecar identity known to the runtime.
- Negative/tradeoffs: a new public surface to version and keep stable (the
  wire protocol, a config section for declared sidecars, a page-side API);
  stdout is reserved for the protocol, so a sidecar that prints to it breaks.
- Risks and mitigations:
  - A malformed or oversized message must not crash or stall the runtime:
    size limits, a bounded queue per sidecar, and malformed lines dropped and
    logged.
  - A sidecar that hangs: per-request timeouts and cancellation.
  - Pipe buffers are finite: a sidecar that stops reading stdin must not block
    the worker that writes to it.
  - Not a sandbox. A sidecar runs with the user's privileges whatever the
    protocol says ([permissions](../permissions.md#a-program-you-start-is-outside-all-of-this)).

## Open questions

Not decided by this ADR. Where [ADR-0003](ADR-0003-plugin-security-model.md)
proposes an answer, it is noted.

1. **Declared or spawned?** Are managed sidecars declared in
   `vantail.config.ts`, or started from the page with a new call? ADR-0003
   proposes: declared, and only declared ones start.
2. **Page API shape.** The proposal suggests
   `sidecars.invoke(name, method, params)` and `sidecars.on(name, event, cb)`.
   ADR-0003 proposes that a page may call only the methods a plugin's manifest
   declares and the config allows.
3. **Protocol versioning.** An `initialize` handshake with a protocol version
   is proposed. ADR-0003 proposes refusing to start on a mismatch.
4. **Streaming and cancellation** are not JSON-RPC features; they need to be
   specified as extensions before anything depends on them.
5. **`examples/chat`.** It serves HTML, which makes it the natural example of
   the HTTP opt-in. Keep it on HTTP, or split it into a page in the bundle and
   a stdio backend?

## Implementation and validation

Not started. Suggested order, each step ending in something testable:

1. Framing and correlation over the existing `process.rs` pipes, with an echo
   sidecar in the integration suite: concurrent requests, out-of-order
   responses, unsolicited notifications.
2. Failure cases in the same suite: malformed lines, an oversized message, a
   sidecar that exits mid-request, one that never answers, one that stops
   reading stdin.
3. The config section and page API, once the open questions are answered.
4. A measurement against loopback HTTP for small calls, concurrent calls and
   large payloads - no performance claim is made here until then.

## Related documents

- [Architecture](../architecture.md)
- [Permissions](../permissions.md)
- [ADR-0002 — Optional native capabilities as sidecar plugins](ADR-0002-native-sidecar-plugins.md)
- [ADR-0003 — Plugin security model](ADR-0003-plugin-security-model.md)
- [`examples/chat`](../../examples/chat)

<!-- Accepted decisions are preserved. To replace one, create a new ADR and link supersession in the index or metadata. -->
