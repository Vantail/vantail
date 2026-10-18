//! `privacy.*` - the OS privacy decision, as distinct from Vantail's own
//! permissions.
//!
//! Vantail's permission layer gates what the *application* may ask the runtime
//! to do. TCC gates what the *process* may do with the OS. Neither implies the
//! other, so nothing here consults `permissions` at all - deliberately. An app
//! that could reach the microphone through the runtime still faces the system
//! prompt, and no config flag can answer that prompt on the user's behalf.
//!
//! Only `microphone`, `camera` and `screen` are wrapped: they are the kinds
//! with a request API that shows the normal system prompt. Everything else
//! with a TCC decision - accessibility, location, contacts - either has no
//! request call or needs a delegate the runtime has no business owning, so
//! those are documented in `docs/macos-privacy.md` rather than wrapped.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::ipc::request::Request;
use crate::state::Runtime;

#[derive(Debug, Deserialize)]
struct KindParams {
    kind: String,
}

fn kind(params: Value, method: &str) -> Result<String, ApiError> {
    let KindParams { kind } = Request::params(method, params)?;
    match kind.as_str() {
        "microphone" | "camera" | "screen" => Ok(kind),
        _ => Err(ApiError::invalid_params(format!(
            "`{method}` needs `kind` to be \"microphone\", \"camera\" or \"screen\", not \"{kind}\""
        ))),
    }
}

pub fn dispatch(rt: &Runtime, method: &str, params: Value) -> ApiResult {
    // No permission gate here - see the module docs. TCC is the gate.
    let _ = rt;
    route(method, params)
}

/// The whole method table, without the runtime handle - which `dispatch`
/// ignores by design. Split out so tests can exercise every arm without
/// building a `Runtime` (which needs an event loop).
fn route(method: &str, params: Value) -> ApiResult {
    match method {
        "privacy.status" => {
            let kind = kind(params, method)?;
            Ok(json!({ "status": status(&kind) }))
        }
        "privacy.request" => {
            let kind = kind(params, method)?;
            Ok(json!({ "status": request(&kind)? }))
        }
        "privacy.openSettings" => {
            open_settings()?;
            Ok(Value::Null)
        }
        _ => Err(ApiError::unknown_method(method)),
    }
}

/// One of `not-determined`, `authorized`, `denied`, `restricted`.
#[cfg(target_os = "macos")]
fn status(kind: &str) -> &'static str {
    map_status(imp::authorization_status(kind))
}

/// Outside macOS there is no TCC to ask; `status` reports that plainly rather
/// than pretending the decision is `denied`.
#[cfg(not(target_os = "macos"))]
fn status(_kind: &str) -> &'static str {
    "unsupported"
}

#[cfg(target_os = "macos")]
fn request(kind: &str) -> Result<&'static str, ApiError> {
    Ok(map_status(imp::request_access(kind)))
}

#[cfg(not(target_os = "macos"))]
fn request(_kind: &str) -> Result<&'static str, ApiError> {
    Err(ApiError::unsupported(
        "Privacy requests are only supported on macOS. Other platforms expose no TCC prompt to show.",
    ))
}

#[cfg(target_os = "macos")]
fn open_settings() -> Result<(), ApiError> {
    open::that_detached(SETTINGS_URL)
        .map_err(|e| ApiError::io("Could not open System Settings", e))?;
    Ok(())
}

/// Deep link into the Privacy & Security pane. A constant so tests can pin
/// the shape without opening anything.
#[cfg(target_os = "macos")]
const SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy";

#[cfg(not(target_os = "macos"))]
fn open_settings() -> Result<(), ApiError> {
    Err(ApiError::unsupported(
        "Opening the privacy settings is only supported on macOS.",
    ))
}

#[cfg(target_os = "macos")]
fn map_status(status: imp::Status) -> &'static str {
    match status {
        imp::Status::NotDetermined => "not-determined",
        imp::Status::Restricted => "restricted",
        imp::Status::Denied => "denied",
        imp::Status::Authorized => "authorized",
    }
}
#[cfg(target_os = "macos")]
mod imp {
    //! The AVFoundation calls, kept behind one door so the mapping above is
    //! the only thing that interprets them.

    use std::sync::mpsc;

    use block2::StackBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVCaptureDevice, AVMediaType, AVMediaTypeAudio, AVMediaTypeVideo};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Status {
        NotDetermined,
        Restricted,
        Denied,
        Authorized,
    }

    pub fn media_type(kind: &str) -> &'static AVMediaType {
        // SAFETY: reading a framework-provided constant string.
        let found = unsafe {
            match kind {
                "microphone" => AVMediaTypeAudio,
                "camera" => AVMediaTypeVideo,
                // Unreachable through `route`: `kind()` rejects anything else
                // first. Panicking rather than falling through, so an unknown
                // kind can never silently become the camera.
                _ => panic!("unknown privacy kind `{kind}`"),
            }
        };
        // The framework always provides these constants; absence would mean a
        // future OS removed them, which is worth failing loudly on.
        found.expect("AVFoundation media type constant is missing")
    }

    pub fn authorization_status(kind: &str) -> Status {
        if kind == "screen" {
            return screen_status();
        }
        // SAFETY: `+authorizationStatusForMediaType:` is a thread-safe class
        // method that touches no Vantail state.
        let raw = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type(kind)) };
        map_raw(raw)
    }

    pub fn request_access(kind: &str) -> Status {
        if kind == "screen" {
            return request_screen();
        }
        // Already decided: answer without prompting. Asking again would be
        // free, the OS just would not show anything - but saying so makes the
        // showcase honest about when the prompt appears.
        let current = authorization_status(kind);
        if !matches!(current, Status::NotDetermined) {
            return current;
        }

        let (tx, rx) = mpsc::channel();
        let block = StackBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        // The request retains the block; this heap copy outlives the stack frame.
        let block = block.copy();

        // SAFETY: same class method, plus a completion block that only sends
        // through a channel. The block fires exactly once and is then released.
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type(kind), &block);
        }

        // The prompt is modal to nothing and fires on an arbitrary queue; a
        // worker thread waiting here keeps the event loop free to draw it.
        // Callers must dispatch `privacy.request` off the main thread.
        //
        // No timeout, deliberately: the system prompt has none, and timing
        // out would misreport the user's eventual answer as a denial. The
        // handler fires exactly once with the outcome, so this cannot wait
        // forever unless the user never answers, in which case waiting *is*
        // the correct behaviour. One held pool thread per unanswered prompt is
        // the same trade the keychain prompt already makes.
        match rx.recv() {
            Ok(true) => Status::Authorized,
            Ok(false) => Status::Denied,
            Err(_) => Status::Denied,
        }
    }

    pub fn map_raw(raw: objc2_av_foundation::AVAuthorizationStatus) -> Status {
        use objc2_av_foundation::AVAuthorizationStatus as S;
        if raw == S::Authorized {
            Status::Authorized
        } else if raw == S::Denied {
            Status::Denied
        } else if raw == S::Restricted {
            Status::Restricted
        } else {
            Status::NotDetermined
        }
    }

    /// Screen recording, via CoreGraphics rather than AVFoundation.
    ///
    /// The preflight call only knows granted or not - unlike AVFoundation
    /// there is no `not-determined` to report, so a first-ever `status` reads
    /// as `denied` until the prompt has been answered. `request` is what shows
    /// the prompt; afterwards both agree. No `Info.plist` key is required.
    pub fn screen_status() -> Status {
        if objc2_core_graphics::CGPreflightScreenCaptureAccess() {
            Status::Authorized
        } else {
            Status::Denied
        }
    }

    fn request_screen() -> Status {
        if objc2_core_graphics::CGPreflightScreenCaptureAccess() {
            return Status::Authorized;
        }
        if objc2_core_graphics::CGRequestScreenCaptureAccess() {
            Status::Authorized
        } else {
            Status::Denied
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    // `dispatch` takes a `&Runtime` it deliberately never reads (TCC - not
    // Vantail permissions - is the gate), and a `Runtime` needs an event loop
    // to build. `route` is the same table without the handle, so these
    // exercise every arm through it instead.
    //
    // Two arms can never run live here: `request` with a valid kind would
    // show a system prompt and wait for a human, and `openSettings` would
    // open System Settings. Both are covered by passing them invalid params -
    // proving validation runs before any OS call - plus the manual steps in
    // `docs/macos-privacy.md`.

    #[test]
    fn an_unknown_method_is_unknown_no_matter_the_params() {
        for params in [json!({}), json!({ "kind": "microphone" }), json!(null)] {
            let error = route("privacy.selfDestruct", params).unwrap_err();
            assert_eq!(error.code, crate::error::code::UNKNOWN_METHOD);
        }
    }

    #[test]
    fn a_bare_namespace_is_not_a_method() {
        let error = route("privacy", json!({})).unwrap_err();
        assert_eq!(error.code, crate::error::code::UNKNOWN_METHOD);
    }

    #[test]
    fn an_unknown_kind_is_rejected_before_touching_the_os() {
        let error = route("privacy.status", json!({ "kind": "location" })).unwrap_err();
        assert_eq!(error.code, crate::error::code::INVALID_PARAMS);
    }

    #[test]
    fn kind_matching_is_exact() {
        // TCC kinds are identifiers, not words: no case folding, no trimming.
        for kind_name in [
            "Microphone",
            "MICROPHONE",
            " microphone",
            "microphone ",
            "",
            "mic",
            "speakers",
        ] {
            let error = kind(json!({ "kind": kind_name }), "privacy.status").unwrap_err();
            assert_eq!(
                error.code,
                crate::error::code::INVALID_PARAMS,
                "`{kind_name}` should not be accepted"
            );
        }
    }

    #[test]
    fn malformed_params_are_invalid_not_internal() {
        // Every shape that is not `{"kind": <string>}` must fail decoding -
        // never reach the OS, and never surface as anything but INVALID_PARAMS.
        let bad = vec![
            json!({}),
            json!(null),
            json!("microphone"),
            json!(42),
            json!(true),
            json!([]),
            json!([{ "kind": "microphone" }]),
            json!({ "kind": null }),
            json!({ "kind": 42 }),
            json!({ "kind": true }),
            json!({ "kind": ["microphone"] }),
            json!({ "kind": { "name": "microphone" } }),
        ];
        for params in bad {
            for method in ["privacy.status", "privacy.request"] {
                let error = route(method, params.clone()).unwrap_err();
                assert_eq!(
                    error.code,
                    crate::error::code::INVALID_PARAMS,
                    "`{method}` accepted `{params}`"
                );
            }
        }
    }

    #[test]
    fn the_error_names_the_method_that_was_called() {
        let error = route("privacy.request", json!({ "kind": "location" })).unwrap_err();
        assert_eq!(error.code, crate::error::code::INVALID_PARAMS);
        assert!(
            error.message.contains("privacy.request"),
            "message should name the method: {}",
            error.message
        );
    }

    #[test]
    fn all_kinds_are_accepted() {
        for kind_name in ["microphone", "camera", "screen"] {
            assert_eq!(
                kind(json!({ "kind": kind_name }), "privacy.status").unwrap(),
                kind_name
            );
        }
    }

    #[test]
    fn extra_params_are_ignored_like_every_other_handler() {
        // `KindParams` has no `deny_unknown_fields`, matching the other
        // `Request::params` shapes: forwards-compatible, still validated.
        assert_eq!(
            kind(
                json!({ "kind": "camera", "future": true }),
                "privacy.status"
            )
            .unwrap(),
            "camera"
        );
    }

    #[test]
    fn status_answers_with_the_documented_shape() {
        let value = route("privacy.status", json!({ "kind": "microphone" })).unwrap();
        let status_text = value
            .get("status")
            .and_then(|status| status.as_str())
            .expect("`privacy.status` answers `{ status }`");
        assert!(
            [
                "not-determined",
                "authorized",
                "denied",
                "restricted",
                "unsupported"
            ]
            .contains(&status_text),
            "unexpected status `{status_text}`"
        );
    }

    #[test]
    fn status_reports_a_known_state_without_prompting() {
        // Neither `authorizationStatusForMediaType:` nor the screen-recording
        // preflight shows UI, so this is safe to run anywhere, including CI.
        for kind_name in ["microphone", "camera", "screen"] {
            let state = status(kind_name);
            let expected = if kind_name == "screen" {
                // CoreGraphics cannot tell "never asked" from "denied", and
                // off macOS there is no TCC at all.
                vec!["authorized", "denied", "unsupported"]
            } else {
                vec![
                    "not-determined",
                    "authorized",
                    "denied",
                    "restricted",
                    "unsupported",
                ]
            };
            assert!(
                expected.contains(&state),
                "unexpected status `{state}` for `{kind_name}`"
            );
        }
    }

    #[test]
    fn request_validates_before_it_could_prompt() {
        // Invalid params must fail even on the arm that would otherwise show
        // UI - this is what keeps a compromised page from reaching the prompt
        // with garbage, and what lets CI cover the arm safely.
        for params in [json!({}), json!({ "kind": "location" }), json!(null)] {
            let error = route("privacy.request", params).unwrap_err();
            assert_eq!(error.code, crate::error::code::INVALID_PARAMS);
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn off_macos_requests_and_settings_are_unsupported() {
        for method in ["privacy.request", "privacy.openSettings"] {
            let params = if method == "privacy.request" {
                json!({ "kind": "microphone" })
            } else {
                json!(null)
            };
            let error = route(method, params).unwrap_err();
            assert_eq!(error.code, crate::error::code::UNSUPPORTED);
        }
    }

    /// macOS only: pure mappings, no prompts, no windows.
    #[cfg(target_os = "macos")]
    mod macos {
        use super::imp::{self, Status};
        use super::*;

        #[test]
        fn every_status_maps_to_its_documented_string() {
            assert_eq!(map_status(Status::NotDetermined), "not-determined");
            assert_eq!(map_status(Status::Authorized), "authorized");
            assert_eq!(map_status(Status::Denied), "denied");
            assert_eq!(map_status(Status::Restricted), "restricted");
        }

        #[test]
        fn every_raw_authorization_value_maps() {
            use objc2_av_foundation::AVAuthorizationStatus as S;
            assert_eq!(imp::map_raw(S::NotDetermined), Status::NotDetermined);
            assert_eq!(imp::map_raw(S::Restricted), Status::Restricted);
            assert_eq!(imp::map_raw(S::Denied), Status::Denied);
            assert_eq!(imp::map_raw(S::Authorized), Status::Authorized);
        }

        #[test]
        fn an_unknown_raw_value_is_never_reported_as_granted() {
            // A future OS adding a fifth state must fail closed: anything
            // unrecognised reads as not-determined, which is the only state
            // that prompts rather than assumes.
            use objc2_av_foundation::AVAuthorizationStatus as S;
            assert_eq!(imp::map_raw(S(99)), Status::NotDetermined);
        }

        #[test]
        fn microphone_and_camera_use_different_media_types() {
            let mic = imp::media_type("microphone");
            let cam = imp::media_type("camera");
            assert!(
                !std::ptr::eq(mic, cam),
                "both kinds must not resolve to the same media type"
            );
        }

        #[test]
        fn media_type_for_an_unknown_kind_fails_loudly() {
            // `kind()` validation runs first, so this is unreachable through
            // `route` - the panic is the backstop, and it must stay one.
            let result = std::panic::catch_unwind(|| imp::media_type("location"));
            assert!(result.is_err());
        }

        #[test]
        fn screen_status_only_knows_granted_or_not() {
            // The preflight call never prompts, so this runs anywhere macOS.
            // Each call is asserted independently: the user could theoretically
            // toggle the decision in Settings between two reads.
            for _ in 0..2 {
                assert!(matches!(
                    imp::screen_status(),
                    Status::Authorized | Status::Denied
                ));
            }
        }

        #[test]
        fn the_settings_deep_link_points_at_privacy() {
            assert!(
                SETTINGS_URL.starts_with("x-apple.systempreferences:"),
                "must be a Settings deep link: {SETTINGS_URL}"
            );
            assert!(
                SETTINGS_URL.contains("security"),
                "must land on the Security pane: {SETTINGS_URL}"
            );
        }
    }
}
