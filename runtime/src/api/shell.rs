//! `shell.*` - handing something to the system's default application.
//!
//! This is a small API with a large blast radius: on every platform, "open
//! this path" can mean "run this program". So it is denied by default and
//! scoped by pattern, and the pattern is matched against the exact string the
//! application asked for.

use serde::Deserialize;
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::ipc::Request;
use crate::state::Runtime;

#[derive(Deserialize)]
struct OpenParams {
    /// A URL, or a path to a file or directory.
    target: String,
    /// Force a particular application instead of the system default.
    #[serde(default)]
    with: Option<String>,
}

pub fn dispatch(rt: &Runtime, method: &str, params: Value) -> ApiResult {
    match method {
        "shell.open" => {
            let OpenParams { target, with } = Request::params(method, params)?;
            rt.permissions.check_open(&target)?;

            let opened = match &with {
                Some(application) => open::with_detached(&target, application),
                None => open::that_detached(&target),
            };

            opened
                .map(|()| Value::Null)
                .map_err(|e| ApiError::io(&format!("Could not open `{target}`"), e))
        }
        _ => Err(ApiError::unknown_method(method)),
    }
}
