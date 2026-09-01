# __APP_NAME__

Built with [Vantail](https://github.com/Vantail/vantail).

```bash
npm install
npm run dev       # native window against the Vite dev server
npm run build     # build the web assets
npm run package   # produce a distributable application
npm run doctor    # check that everything needed is installed
```

There is no Node.js in this app. `node:fs` and friends do not exist - use
`@vantail/api` instead:

```ts
import { dialog, filesystem } from "@vantail/api";

const path = await dialog.openFile();
if (path) console.log(await filesystem.readText(path));
```

Native access is denied by default and granted in `vantail.config.ts`. The same
file also describes the application menu, and can add a tray icon and a
self-updater.

More windows are labels, opened at runtime:

```ts
import { app, createWindow } from "@vantail/api";

const settings = await createWindow("settings", { url: "settings.html" });
await app.emit("hello", { from: "main" }, { to: "settings" });
```
