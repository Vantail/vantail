//! `notification.*` - desktop notifications.

use serde::Deserialize;
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::ipc::Request;
use crate::state::Runtime;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ShowParams {
    title: String,
    body: String,
    /// Platform-specific icon name or path. Ignored where unsupported.
    icon: Option<String>,
}

pub fn dispatch(rt: &Runtime, method: &str, params: Value) -> ApiResult {
    rt.permissions
        .require(rt.permissions.notification, method)?;

    match method {
        "notification.show" => {
            let params: ShowParams = Request::params(method, params)?;
            show(rt, &params)
        }
        _ => Err(ApiError::unknown_method(method)),
    }
}

fn show(rt: &Runtime, params: &ShowParams) -> ApiResult {
    let mut notification = notify_rust::Notification::new();
    notification
        .summary(if params.title.is_empty() {
            &rt.config.app.name
        } else {
            &params.title
        })
        .body(&params.body)
        .appname(&rt.config.app.name);

    if let Some(icon) = &params.icon {
        notification.icon(icon);
    }

    notification.show().map(|_| Value::Null).map_err(|e| {
        // macOS delivers notifications through the bundle identifier, so an
        // unbundled `vantail dev` build genuinely cannot post one. Say so
        // rather than reporting a generic failure.
        if cfg!(target_os = "macos") {
            ApiError::unsupported(format!(
                "Could not post a notification: {e}. On macOS notifications require a bundled app - try `vantail package`."
            ))
        } else {
            ApiError::internal(format!("Could not post a notification: {e}"))
        }
    })
}
