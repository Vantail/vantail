//! `shortcut.*` - key combinations that work when the app is not in front.
//!
//! There is no browser API for this, and there cannot be: a page only sees
//! keys while it has focus, and the point of a global shortcut is that it
//! fires when something else does.
//!
//! A registration is system-wide, so it can fail simply because another
//! application already owns the combination. That is an ordinary outcome
//! rather than a bug, and it is reported as one.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::ipc::request::Request;
use crate::state::MainCtx;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterParams {
    /// `CmdOrCtrl+Shift+K`, in the same spelling menu accelerators use.
    accelerator: String,
    /// What the `shortcut.pressed` event reports. Defaults to the accelerator.
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcceleratorParams {
    accelerator: String,
}

pub fn dispatch(ctx: &mut MainCtx<'_>, method: &str, params: Value) -> ApiResult {
    ctx.rt
        .permissions
        .require(ctx.rt.permissions.shortcut, method)?;

    match method {
        "shortcut.register" => {
            let RegisterParams { accelerator, id } = Request::params(method, params)?;
            let id = id.unwrap_or_else(|| accelerator.clone());
            ctx.chrome.register_shortcut(&accelerator, &id)?;
            Ok(json!({ "id": id, "accelerator": accelerator }))
        }

        "shortcut.unregister" => {
            let AcceleratorParams { accelerator } = Request::params(method, params)?;
            ctx.chrome.unregister_shortcut(&accelerator)?;
            Ok(Value::Null)
        }

        "shortcut.unregisterAll" => {
            ctx.chrome.unregister_all_shortcuts()?;
            Ok(Value::Null)
        }

        "shortcut.isRegistered" => {
            let AcceleratorParams { accelerator } = Request::params(method, params)?;
            Ok(json!(ctx.chrome.shortcut_registered(&accelerator)))
        }

        "shortcut.list" => Ok(json!(ctx.chrome.shortcuts())),

        _ => Err(ApiError::unknown_method(method)),
    }
}
