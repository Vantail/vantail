//! `os.*` - read-only facts about the machine.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::Runtime;

pub fn dispatch(rt: &Runtime, method: &str, _params: Value) -> ApiResult {
    rt.permissions.require(rt.permissions.os, method)?;

    match method {
        "os.platform" => Ok(json!(platform())),
        // Whether this build reports sleep and wake, so an application can
        // fall back to its own timer where it does not.
        "os.powerEvents" => Ok(json!(crate::power::supported())),
        "os.arch" => Ok(json!(std::env::consts::ARCH)),
        "os.homeDir" => path(dirs::home_dir(), "home directory"),
        "os.tempDir" => path(Some(std::env::temp_dir()), "temp directory"),
        "os.appDataDir" => path(
            dirs::data_dir().map(|d| d.join(&rt.config.app.identifier)),
            "application data directory",
        ),
        "os.appConfigDir" => path(
            dirs::config_dir().map(|d| d.join(&rt.config.app.identifier)),
            "application config directory",
        ),
        "os.resourceDir" => path(Some(rt.resource_dir.clone()), "resource directory"),
        "os.info" => Ok(json!({
            "platform": platform(),
            "arch": std::env::consts::ARCH,
            "family": std::env::consts::FAMILY,
        })),
        _ => Err(ApiError::unknown_method(method)),
    }
}

/// The platform name, as an application sees it.
///
/// Rust already spells these `macos`, `windows` and `linux`, which is what a
/// web developer expects, so there is nothing to translate - this exists to
/// give the name one place to live if that ever stops being true.
fn platform() -> &'static str {
    std::env::consts::OS
}

fn path(value: Option<PathBuf>, what: &str) -> ApiResult {
    match value {
        Some(path) => Ok(json!(path.to_string_lossy())),
        None => Err(ApiError::unsupported(format!("This system has no {what}"))),
    }
}
