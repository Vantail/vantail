pub mod app;
pub mod autostart;
pub mod clipboard;
pub mod deeplink;
pub mod dialog;
pub mod filesystem;
#[cfg(feature = "hid")]
pub mod hid;

/// The same entry point for builds without raw device access.
#[cfg(not(feature = "hid"))]
pub mod hid {
    use std::sync::Arc;

    use serde_json::Value;

    use crate::error::{ApiError, ApiResult};
    use crate::state::Runtime;

    /// A placeholder so `Runtime` has the field either way.
    #[derive(Default)]
    pub struct Devices;

    impl Devices {
        pub fn shutdown(&self) {}
    }

    pub fn dispatch(_rt: &Arc<Runtime>, _source: &str, _method: &str, _params: Value) -> ApiResult {
        Err(ApiError::unsupported(
            "This runtime was built without HID access. Rebuild with the `hid` feature enabled.",
        ))
    }
}

#[cfg(feature = "mdns")]
pub mod mdns;

/// The same entry point for builds without service discovery.
#[cfg(not(feature = "mdns"))]
pub mod mdns {
    use serde_json::Value;

    use crate::error::{ApiError, ApiResult};
    use crate::state::MainCtx;

    /// A placeholder so `Runtime` has the field either way.
    #[derive(Default)]
    pub struct Discovery;

    impl Discovery {
        pub fn shutdown(&self) {}
    }

    pub fn dispatch(
        _ctx: &mut MainCtx<'_>,
        _id: &str,
        _method: &str,
        _params: Value,
    ) -> Option<ApiResult> {
        Some(Err(ApiError::unsupported(
            "This runtime was built without service discovery. Rebuild with the `mdns` feature enabled.",
        )))
    }
}

pub mod menu;
#[cfg(feature = "network")]
pub mod network;

/// The same entry point for builds without an HTTP client, so an application
/// gets a clear answer rather than `UNKNOWN_METHOD`.
#[cfg(not(feature = "network"))]
pub mod network {
    use serde_json::Value;

    use crate::error::{ApiError, ApiResult};
    use crate::state::MainCtx;

    pub fn dispatch(
        _ctx: &mut MainCtx<'_>,
        _id: &str,
        _method: &str,
        _params: Value,
    ) -> Option<ApiResult> {
        Some(Err(ApiError::unsupported(
            "This runtime was built without the network client. Rebuild with the `network` feature enabled.",
        )))
    }
}
pub mod notification;
pub mod os;
pub mod process;

pub mod screen;

#[cfg(feature = "secrets")]
pub mod secrets;

/// The same entry point for builds without a credential store.
#[cfg(not(feature = "secrets"))]
pub mod secrets {
    use serde_json::Value;

    use crate::error::{ApiError, ApiResult};
    use crate::state::Runtime;

    pub fn dispatch(_rt: &Runtime, _method: &str, _params: Value) -> ApiResult {
        Err(ApiError::unsupported(
            "This runtime was built without the credential store. Rebuild with the `secrets` feature enabled.",
        ))
    }
}
pub mod shell;
pub mod shortcut;
pub mod tray;
#[cfg(feature = "watch")]
pub mod watch;

/// The same entry point without the feature, so an application gets an answer
/// it can act on rather than `UNKNOWN_METHOD`.
#[cfg(not(feature = "watch"))]
pub mod watch {
    use std::sync::Arc;

    use serde_json::Value;

    use crate::error::ApiResult;
    use crate::state::Runtime;

    #[derive(Default)]
    pub struct State;

    pub fn dispatch(_rt: &Arc<Runtime>, _source: &str, _method: &str, _params: Value) -> ApiResult {
        Err(crate::error::ApiError::unsupported(
            "This runtime was built without filesystem watching. Rebuild with the `watch` feature enabled.",
        ))
    }
}

pub mod window;
