# @vantail/runtime

Finds the precompiled [Vantail](https://github.com/Vantail/vantail) native
runtime for the machine it is running on.

You do not usually install this yourself. `@vantail/cli` depends on it, and
that is how an application gets a runtime.

```bash
npm create @vantail my-app
```

## How it works

The promise Vantail makes is that an application developer never compiles
Rust. That works because the runtime ships as one package per platform, each
containing a single executable:

```text
@vantail/runtime-darwin-arm64
@vantail/runtime-win32-x64
@vantail/runtime-win32-arm64
@vantail/runtime-linux-x64
@vantail/runtime-linux-arm64
```

Each declares `os` and `cpu`, and they are optional dependencies of this
package, so npm downloads the one binary that matches and skips the rest.

This package resolves in order:

1. `$VANTAIL_RUNTIME_BIN` - an explicit path, for pointing at a build of your
   own.
2. `@vantail/runtime-<platform>-<arch>` - resolved from the project first,
   then from the CLI's own location, so an application can pin a runtime
   version that differs from its CLI.
3. A `cargo build` in a surrounding workspace, for anyone building the runtime
   themselves.

`vantail doctor` prints which one it found and why.

MIT licensed.
