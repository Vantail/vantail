//! `deeplink.*` - the application's own URL scheme.

use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::Runtime;

pub fn dispatch(rt: &Runtime, method: &str, _params: Value) -> ApiResult {
    match method {
        "deeplink.protocols" => Ok(json!(rt.config.protocols)),

        // Subscribing is what releases anything held from before the window
        // existed - an application launched *by* a link would otherwise never
        // see the link that launched it.
        "deeplink.subscribe" => Ok(json!(rt.links.drain())),

        _ => Err(ApiError::unknown_method(method)),
    }
}
