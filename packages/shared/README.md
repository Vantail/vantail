# @vantail/shared

Configuration types, schema and loader shared between the
[Vantail](https://github.com/Vantail/vantail) command line and the runtime.

This is tooling, not something an application imports. If you are building an
application, you want [`@vantail/api`](https://www.npmjs.com/package/@vantail/api)
for the native APIs and
[`@vantail/cli`](https://www.npmjs.com/package/@vantail/cli) for
`defineConfig`.

```bash
npm create @vantail my-app
```

## What is in it

The single definition of what `vantail.config.ts` may contain: the window, the
menu, the tray, the updater, and the permission model. The CLI validates
against it and compiles it to the `vantail.json` the native runtime reads at
startup, so both sides agree on the shape without either owning it.

MIT licensed.
