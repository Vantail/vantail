# Splash - a window with a shape of its own, handing over to one that draws its own title bar

An orange splash screen with no frame and no buttons, a progress bar that runs
for five seconds, and a handover to an application window whose title bar is
the application's rather than the platform's.

React, Tailwind v4 and shadcn/ui.

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
that shape, so nothing in `src/index.css` sets a `border-radius` of its own and
the orange simply runs to the edge.

`backgroundColor` is the same orange. It is what shows before the page has
painted, so the window never appears as a pale rectangle first.

Nothing drags this window, and nothing had to be written to stop it: the drag
band the runtime uses is the one a hidden title bar leaves behind, and a window
with no title bar at all leaves none.

## The handover

The window the config opens is the splash, not the application. When the bar
fills, `src/SplashScreen.tsx` opens the real window and then closes itself:

```ts
await createWindow("app", {
  url: "app.html",
  titleBarStyle: "hidden",
  titleBarHeight: BAR_HEIGHT,
  backgroundColor: dark ? BACKGROUND.dark : BACKGROUND.light,
  // ...
});

await appWindow.close();
```

**That order matters.** Closing the last window quits, so a splash that shuts
before the application exists takes the process with it. `createWindow`
resolves once the new window's page is running, so by the time it returns there
is something to hand over to.

**The options matter too.** A window made at runtime starts from the defaults,
not from `window` in the config - the config describes the splash - so
everything the application window needs is asked for in this call. That is why
`titleBarStyle` is here and not in `vantail.config.ts`.

The second window is a second HTML entry point, which Rollup has to be told
about - see `vite.config.ts`.

## The title bar

`titleBarStyle: "hidden"` takes the platform's bar away and lets the page run
to the top edge of the window. `src/TitleBar.tsx` draws what goes there.

Three things make that bar a title bar rather than a div at the top of a page.

**It is laid out from the platform's numbers, not from constants.**
`titleBarMetrics()` reports what the platform reserved - `insetLeft` for the
traffic lights macOS keeps, zero on the platforms that keep nothing - and the
bar pads itself by that. The runtime writes those numbers before the page lays
out, so the first render is already right: no effect, no flash, no hardcoded 28
that is wrong on half the machines it runs on.

**It moves the window, without a line of JavaScript.** The runtime drags from
the band a hidden bar left behind, which is `titleBarHeight` pixels tall, and
skips the controls inside it - so the bar drags and its buttons still click.
`BAR_HEIGHT` in `src/window.ts` is passed to `createWindow` and used for the
layout, so the band and the bar are the same strip by construction.

**Its window controls are the platform's, not the design system's.**
`src/WindowControls.tsx` branches on `os.infoSync()`: round coloured dots on
the leading edge for macOS, 46-point square captions with a red close on the
trailing edge for Windows, grey circles for GNOME. Traffic lights on Windows
read as a web page wearing a window, and Windows' captions on macOS read the
same way. They are the one part of this example not built out of shadcn's
`Button` - a caption button that picks up an accent colour, a focus ring and a
rounded corner from the design system is the tell of a bar that is only a
picture of one.

Which branch draws is decided by measuring rather than by the platform's name:
where the platform reserved nothing on the leading edge, it drew no buttons
either. On macOS it reserved 78 points and this application draws none.

## shadcn/ui

Stock, and set up the way the registry expects, so `npx shadcn@latest add ...`
lands in a project it already understands:

- `components.json` - style, base colour, and the `@/` aliases
- `src/lib/utils.ts` - `cn()`
- `src/components/ui/` - `button`, `card`, `badge`, `progress`, unmodified
- `src/index.css` - Tailwind v4 takes its configuration from CSS, so this file
  is the whole of it. shadcn's neutral palette, plus one token of this
  application's own: `--brand`, the orange the splash is painted in.

The `@/` specifier is taught twice: to the type checker in `tsconfig.json`, and
to the bundler in `vite.config.ts`. Both are needed.

**One thing worth copying.** The splash bends `Progress` from the outside,
through arbitrary variants on the element that uses it, rather than by editing
the component - which keeps `src/components/ui/progress.tsx` a file the
registry can still update:

```tsx
<Progress
  value={progress * 100}
  className="h-1.5 bg-black/20
             [&>[data-slot=progress-indicator]]:bg-white
             [&>[data-slot=progress-indicator]]:transition-none"
/>
```

`transition-none` is not cosmetic. The stock indicator carries
`transition-all`, which is right for a bar that ticks over a few times and
wrong for one driven every animation frame: each frame restarts the 150ms
transition from where the last one had got to, and a transition never allowed
to finish gets nowhere. Without it the inline style reads 73% while the bar on
screen is still sitting at 1%.

## Light and dark

The application window follows the system. `src/theme.ts` puts shadcn's `.dark`
class on the document before React mounts, so the first frame is already the
right colour rather than a white one that turns dark a tick later.

The window's `backgroundColor` has to agree with it, and it is chosen at
`createWindow` time from `matchMedia`. That colour is a hex duplicate of
`--background` rather than something read out of the stylesheet, and it has to
be: it is on screen while the page does not yet exist, so anything derived from
CSS would arrive a paint too late to be the thing that shows first. It is also
what fills the strip a live resize opens up while the web view catches up -
without it, a dark application flashes white down one side every time it is
dragged wider.

It does not follow a change of theme made while the window is open. Repainting
it would mean the runtime letting a window change its background after the
fact, which it does not.

## Notes

- The progress is driven from a wall-clock deadline rather than by adding a
  slice per frame. A bar that counts frames finishes late on a busy machine,
  and a splash is on screen precisely because the machine is busy.
- The handover is guarded against running twice. React's strict mode runs
  effects twice in development, and asking for a window label that is already
  taken rejects - which would leave the splash on screen for good.
- `borderRadius` applies to a window with no frame, on macOS and Windows.
  Windows draws the shape as a region, so its edges are hard where macOS
  anti-aliases them, and the window has no drop shadow. On Linux the window is
  square for now and everything else here still works.
