# Camera

A minimal camera app showing the intended shape of `privacy.*` on macOS: check
the OS decision, ask once, preview when granted - and send the user to System
Settings when the answer is no. Nothing is recorded; asking is the whole
demonstration.

## Run it

From this directory:

```bash
pnpm dev     # same as `vantail dev`: the app in a native window, with HMR
```

Three steps, in order:

1. **Check status** calls `privacy.status("camera")`. It never prompts - it
   answers `not-determined` / `authorized` / `denied` / `restricted` (or
   `unsupported` off macOS).
2. **Ask for access** calls `privacy.request("camera")` when the status is
   `not-determined`. The first call shows the normal system prompt; later calls
   answer from the stored decision without prompting.
3. **Start preview** opens the camera through the webview's own
   `navigator.mediaDevices.getUserMedia({ video: true })` - the WebKit path to
   the same TCC decision, not a runtime API. **Stop** releases the tracks.

**Open Settings** calls `privacy.openSettings()`, which deep-links to Privacy
& Security. A `denied` decision can only be reversed there, by the user.

## Why the config looks like this

`vantail.config.ts` sets `macos.cameraUsageDescription` and nothing else.
Without that string macOS denies capture without ever prompting - see
`docs/macos-privacy.md`. It grants nothing; it lets the OS ask.

There is deliberately no `permissions` block: `privacy.*` needs no Vantail
permission flag. TCC gates what the *process* may do with the OS; Vantail's
permissions gate what the *application* may ask the runtime to do. Neither
implies the other.

## Trying the states

- Fresh state: status reads `not-determined`, no prompt shown.
- Request: the system prompt appears; Allow reads `authorized` and the preview
  works.
- Revoke in System Settings → Privacy & Security → Camera: status reads
  `denied`, requesting no longer prompts, and Open Settings takes you back.
- Grants belong to the running app's identity, so `vantail dev` and the
  packaged `.app` keep separate decisions - test the packaged build
  (`pnpm package`) before concluding anything about the prompt flow.
