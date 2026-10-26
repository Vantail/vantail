# Architecture decisions

One file per significant decision: its context, the options considered, what
was chosen and why, and what it costs. An accepted record is kept as it was;
a later change of mind gets a new record that supersedes it.

| ID | Decision | Status |
| --- | --- | --- |
| [ADR-0001](ADR-0001-runtime-managed-sidecar-ipc.md) | Runtime-managed sidecars over a JSON-RPC stdio protocol | Proposed |
| [ADR-0002](ADR-0002-native-sidecar-plugins.md) | Optional native capabilities as sidecar plugins, starting with SQLite | Proposed |
| [ADR-0003](ADR-0003-plugin-security-model.md) | Plugin security model | Proposed |
| [ADR-0004](ADR-0004-plugin-distribution.md) | How plugins are distributed | Proposed |

How the system works today is in [architecture.md](../architecture.md). None
of the decisions above is implemented; that document changes when one is.
