# @vantail/cli

The command line for [Vantail](https://github.com/Vantail/vantail): run an
application in a native window, and turn it into something people can install.

```bash
npm create @vantail my-app
```

The scaffolder installs this for you. Otherwise:

```bash
npm install --save-dev @vantail/cli
```

## Commands

```bash
vantail dev        # native window against the Vite dev server, with HMR
vantail build      # build the web assets
vantail package    # lay out a distributable application
vantail doctor     # check that everything needed to run is present
vantail updater    # keygen | sign | manifest
```

`vantail dev` starts Vite, points a real webview at it, and ties their
lifetimes together: close the window and the server stops, stop the CLI and
the window closes. Editing the config reopens the window, since window size
and permissions are read once at startup.

`vantail package` produces a `.app` on macOS and a portable folder elsewhere.
It copies a precompiled runtime binary; there is no compilation step and no
Rust toolchain involved. Add `--installer` for the thing a user downloads: a
`.dmg` on macOS, an `.msi` on Windows, a `.deb` on Linux.

`vantail doctor` prints which runtime it found and why, which is the first
thing to run when something will not start.

## Configuration

`defineConfig` is exported from here, so the config file is typed:

```ts
// vantail.config.ts
import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "My App",
    identifier: "dev.example.myapp",
    version: "1.0.0",
    // One square PNG. Every size each platform asks for is scaled from it.
    icon: "icon.png",
  },

  window: { width: 1200, height: 800 },

  permissions: {
    dialog: true,
    filesystem: {
      read: ["$DOCUMENT/**"],
      write: ["$APPDATA/**"],
    },
  },
});
```

Nothing native is available until the config asks for it. `$DOCUMENT`,
`$APPDATA` and the rest resolve to the right directory per platform.

## Documentation

- [Configuration and permissions](https://github.com/Vantail/vantail/blob/main/docs/permissions.md)
- [Bundles, installers and signing](https://github.com/Vantail/vantail/blob/main/docs/packaging.md)
- [Shipping updates](https://github.com/Vantail/vantail/blob/main/docs/updater.md)

MIT licensed.
