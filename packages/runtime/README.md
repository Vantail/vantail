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

That list is the whole list. **There is no Intel Mac build** - `darwin-x64` is
not published, so an application cannot run there. On a platform with no
runtime this package throws `UnsupportedPlatformError`, naming the platform
asked for and the ones that exist, rather than telling you to install a package
that does not exist. `vantail doctor` reports the same thing, and `npm create
@vantail` refuses before writing a project.

The list comes from `platforms.json`, which ships inside this package and is
what the release pipeline builds from - so what an installed copy reports is
what was actually published. Read it yourself if you need to:

```ts
import { supportedTargets, supportedPlatformNames, isSupportedPlatform } from "@vantail/runtime";

supportedPlatformNames();          // ["darwin-arm64", "win32-x64", ...]
isSupportedPlatform("darwin", "x64");  // false
supportedTargets();                // the same, plus rust triple and tier
```

## Two builds of each

Every platform is published twice. The `-sqlcipher` build adds database
encryption, and about 3 MB of crypto with it:

```text
@vantail/runtime-darwin-arm64            every capability except encryption
@vantail/runtime-darwin-arm64-sqlcipher  the same, plus SQLCipher
```

An application asks for the second by declaring what it needs, not by naming a
package:

```ts
permissions: { database: { encryption: true }, secrets: true }
```

`vantail dev`, `vantail package` and `vantail doctor` read that and resolve the
matching build. Everything else gets the ordinary one, and never downloads the
encrypted binary.

This package resolves in order:

1. `$VANTAIL_RUNTIME_BIN` - an explicit path, for pointing at a build of your
   own.
2. `@vantail/runtime-<platform>-<arch>`, or its `-sqlcipher` variant -
   resolved from the project first, then from the CLI's own location, so an
   application can pin a runtime version that differs from its CLI.
3. A `cargo build` in a surrounding workspace, for anyone building the runtime
   themselves.

`vantail doctor` prints which one it found and why.

Step 2 is only attempted for a platform that is published. Step 1 is checked
first on purpose: pointing `$VANTAIL_RUNTIME_BIN` at a runtime you compiled
yourself works on any platform, and this package does not second-guess that.

Two failures, kept distinct because the answer differs. `RuntimeNotFoundError`
means the platform is supported but nothing is installed here, and it names the
`npm install` that fixes it. `UnsupportedPlatformError` means there is nothing
to install.

MIT licensed.
