# @vantail/vite

The Vite plugin for [Vantail](https://github.com/Vantail/vantail).

You do not usually add this yourself. `@vantail/cli` applies it for you, and
`vantail dev` and `vantail build` are the commands you run.

```bash
npm create @vantail my-app
```

## What it does

It sets the handful of things a Vite project needs in order to be loaded by a
native webview rather than a browser:

- relative asset paths, because a packaged application is served from a
  `vantail://` protocol rather than from a web root
- a build target matching the webview each platform actually has, so output is
  not transpiled further than it needs to be
- the dev server settings `vantail dev` expects when it points a real window
  at it

## Using it directly

Only necessary if you are composing your own Vite config rather than letting
the CLI do it:

```ts
import { defineConfig } from "vite";
import { vantail } from "@vantail/vite";

export default defineConfig({
  plugins: [vantail()],
});
```

MIT licensed.
