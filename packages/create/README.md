# @vantail/create

The scaffolder for [Vantail](https://github.com/Vantail/vantail): a native
desktop application whose interface is a web page, with no Rust project and no
Node.js runtime to ship.

```bash
npm create @vantail my-app
cd my-app
npm install
npm run dev
```

That last command opens a real native window, with hot module replacement
still working.

## Templates

Pick one when asked, or name it up front with `--template`:

| Template     | What you get                      |
| ------------ | --------------------------------- |
| `react-ts`   | React and TypeScript              |
| `svelte-ts`  | Svelte and TypeScript             |
| `vue-ts`     | Vue and TypeScript                |
| `vanilla-ts` | TypeScript, no framework          |

```bash
npm create @vantail my-app -- --template svelte-ts
```

Each one is a Vite project with `@vantail/api` wired in and a
`vantail.config.ts` that asks for the handful of permissions the starter code
actually uses.

## What you get

```text
my-app/
  vantail.config.ts   the window, the icon, and what the app may reach
  index.html
  src/
  icon.png            one square PNG; every platform size is scaled from it
```

Then:

```bash
npm run dev        # native window, HMR
npm run build      # the web assets
npm run package    # a .app, or a portable folder
```

## Documentation

- [The API you can call](https://github.com/Vantail/vantail/blob/main/docs/api.md)
- [The permission model](https://github.com/Vantail/vantail/blob/main/docs/permissions.md)

MIT licensed.
