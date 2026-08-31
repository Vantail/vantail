# Splash - a window with a shape of its own

An orange splash screen with no frame and no buttons, a progress bar that
runs for five seconds, and a handover to the real application window.

```sh
pnpm dev
```

## The shape

```ts
window: {
  decorations: false,
  borderRadius: { topLeft: 15, topRight: 0, bottomRight: 15, bottomLeft: 30 },
}
```

`decorations: false` is what takes the title bar and the window buttons with
it. `borderRadius` gives each corner its own value - square at the top right,
15 on two of them, 30 at the bottom left - and the runtime clips the page to
that shape, so `src/splash.css` sets no `border-radius` of its own and the
orange simply runs to the edge.

`backgroundColor` is the same orange. It is what shows before the page has
painted, so the window never appears as a pale rectangle first.

Nothing drags this window, and nothing had to be written to stop it: the drag
band the runtime uses is the one a hidden title bar leaves behind, and a
window with no title bar at all leaves none.

## The handover

The window the config opens is the splash, not the application. When the bar
fills, `src/splash.ts` opens the real window and then closes itself:

```ts
await createWindow("app", { url: "app.html", width: 860, height: 560 });
await appWindow.close();
```

**That order matters.** Closing the last window quits, so a splash that shuts
before the application exists takes the process with it. `createWindow`
resolves once the new window's page is running, so by the time it returns
there is something to hand over to.

The second window is a second HTML entry point, which Rollup has to be told
about - see `vite.config.ts`. It gets none of the splash's settings: a window
made at runtime starts from the defaults, not from `window` in the config, so
the application window is framed like any other.

## Notes

- The progress is driven from a wall-clock deadline rather than by adding a
  slice per frame. A bar that counts frames finishes late on a busy machine,
  and a splash is on screen precisely because the machine is busy.
- `borderRadius` applies to a window with no frame, on macOS and Windows.
  Windows draws the shape as a region, so its edges are hard where macOS
  anti-aliases them, and the window has no drop shadow. On Linux the window is
  square for now and everything else here still works.
