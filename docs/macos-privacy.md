# macOS Privacy (TCC) — Audit and Implementation Notes

How Vantail relates to macOS Transparency, Consent, and Control (TCC).

## Audit findings (2026-10-12, against `release/0.1.25`)

- **No TCC integration existed.** Nothing in `runtime/`, `packages/cli/src/bundle/macos.ts`,
  `packages/api/src/` or `example/showcase` referenced microphone, camera, location,
  screen recording, accessibility, `Info.plist` usage descriptions, entitlements, or TCC.
  The only `Info.plist` keys emitted were bundle identity, icon, version, minimum OS,
  high-resolution, `LSUIElement`, and URL schemes.
- **Permission attribution was untested.** TCC attributes decisions to the bundle
  identifier of the running process. During `vantail dev` the process is the raw
  runtime binary (no bundle, ad-hoc identity); after `vantail package` it is the
  `.app` bundle. These are different TCC identities with independent grants.
- **WebKit behavior was undocumented.** `WKWebView` (via wry) routes
  `navigator.mediaDevices.getUserMedia()` through TCC itself, but macOS still requires
  `NSMicrophoneUsageDescription` / `NSCameraUsageDescription` in the app's `Info.plist`.
  Without them, capture fails without ever prompting.
- **Vantail's permission layer is separate by design** (`docs/permissions.md`,
  `runtime/src/permissions/`). It gates what the *application* may ask the runtime to do.
  TCC gates what the *process* may do with the OS. Neither implies the other, and this
  implementation keeps them that way: `privacy.*` requires no Vantail permission flag.

## What was implemented

- `privacy.status(kind)` / `privacy.request(kind)` for `microphone` and `camera`
  (`runtime/src/api/privacy.rs`, macOS via `AVCaptureDevice`, `objc2-av-foundation`).
  States: `not-determined` / `authorized` / `denied` / `restricted`. On other platforms
  both calls fail with `UNSUPPORTED_PLATFORM`.
- `privacy.openSettings()` opens the Privacy & Security settings pane on macOS so a user
  can reverse a denial; unsupported elsewhere.
- `macos.microphoneUsageDescription` / `macos.cameraUsageDescription` config keys,
  emitted as `NSMicrophoneUsageDescription` / `NSCameraUsageDescription` in the packaged
  `Info.plist` (`packages/cli/src/bundle/macos.ts`, validated in
  `packages/shared/src/schema.ts`). Without these strings macOS will not prompt.
- Showcase panel `privacy` (`examples/showcase/src/panels/privacy.ts`) demonstrating
  status → request → granted/denied handling for the microphone, plus the WebKit
  `getUserMedia` path and a pointer to System Settings.
- No entitlements are required for microphone/camera. Screen recording, accessibility,
  location, contacts, and protected files/folders have no programmatic request API that
  a runtime should call; they are documented below rather than wrapped.

## Platform-specific limitations

- **Microphone / camera**: requestable. First call shows the system prompt (attributed to
  the running bundle); later calls return the stored decision without prompting.
  A `denied` decision can only be reversed by the user in System Settings
  (`privacy.openSettings()` takes them there). `restricted` (e.g. MDM / Screen Time)
  cannot be changed by the user or the app.
- **Dev vs packaged identity**: grants obtained under `vantail dev` do not carry over
  to the packaged `.app` (different bundle identity), and vice versa. Test the packaged
  build before concluding anything about the prompt flow.
- **Missing usage description**: if the `Info.plist` lacks the matching
  `NS*UsageDescription`, macOS denies capture without prompting (and logs to Console).
  `vantail doctor` / packaging docs remind you to set `macos.*UsageDescription`.
- **Screen recording / accessibility**: no request API exists; the app can only detect
  the state indirectly (capture returns blank / events never arrive) and direct the user
  to System Settings. Not wrapped — document and deep-link instead.
- **Location**: requestable only via CoreLocation (`CLLocationManager`), which needs a
  usage description plus a run-loop delegate; not wrapped in this iteration. Web
  geolocation in the webview follows the same WebKit path as media.
- **Contacts, calendars, reminders, photos, files/folders**: user-granted via system
  pickers (powerbox) or Full Disk Access in Settings; the file dialog grant
  (`grantFromDialog`) already models the picker side. Not wrapped.
- **Code signing**: TCC decisions stick to the bundle identifier *and* signing identity.
  Ad-hoc signatures (`vantail package` default) work on the build machine; changing the
  identity later (e.g. ad-hoc → Developer ID) resets prior grants.

## Verification (2026-10-12, Apple Silicon, macOS)

Mechanically verified on this machine:

- The real `AVCaptureDevice authorizationStatusForMediaType:` call returns a valid
  state (`runtime/src/api/privacy.rs` unit test, run on-device).
- `vantail package` emits both `NSMicrophoneUsageDescription` and
  `NSCameraUsageDescription` into the showcase bundle's `Info.plist`, with
  `CFBundleIdentifier` `dev.vantail.showcase` (checked in the built `.app`).
- The packaged binary is the fresh release build containing `privacy.*` dispatch.
- `codesign -dv` reports `Identifier=dev.vantail.showcase, Signature=adhoc` - the
  identity TCC attributes grants to.
- The packaged showcase launches with zero errors/faults in the unified log and
  quits cleanly.

Not automated (no GUI automation is available in this environment), to verify by
hand in the showcase `privacy` panel on a test machine:

1. Fresh state: `status()` → `not-determined`, no prompt shown.
2. `request()` → system prompt appears; Allow → `authorized`, and the microphone
   works (also via the `getUserMedia` button).
3. Revoke in System Settings → Privacy & Security → Microphone; `status()` →
   `denied`; `request()` no longer prompts; `openSettings()` deep-links back.
4. Repeat 1-3 with the packaged `.app`, not just `vantail dev` - the two are
   different TCC identities with independent grants.
