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
    open::that_detached("x-apple.systempreferences:com.apple.preference.security?Privacy")
        .map_err(|e| ApiError::io("Could not open System Settings", e))?;
    Ok(())
}

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

    pub enum Status {
        NotDetermined,
        Restricted,
        Denied,
        Authorized,
    }

    fn media_type(kind: &str) -> &'static AVMediaType {
        // SAFETY: reading a framework-provided constant string.
        let found = unsafe {
            if kind == "microphone" {
                AVMediaTypeAudio
            } else {
                AVMediaTypeVideo
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
        match rx.recv() {
            Ok(true) => Status::Authorized,
            Ok(false) => Status::Denied,
            Err(_) => Status::Denied,
        }
    }

    fn map_raw(raw: objc2_av_foundation::AVAuthorizationStatus) -> Status {
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
    fn screen_status() -> Status {
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
    // to build. So these exercise everything below that boundary: the `kind`
    // validation every call passes through, and - on macOS - the real status
    // query, which never prompts.
    #[test]
    fn an_unknown_kind_is_rejected_before_touching_the_os() {
        let error = kind(json!({ "kind": "location" }), "privacy.status").unwrap_err();
        assert_eq!(error.code, crate::error::code::INVALID_PARAMS);
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
}
