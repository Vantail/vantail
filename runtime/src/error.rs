//! The single error type that crosses the IPC boundary.
//!
//! Every native API returns `ApiResult`. Errors are serialised as
//! `{ "code": "...", "message": "..." }` so the TypeScript SDK can turn them
//! back into a `VantailError` with a stable, matchable `code`.

use serde::Serialize;
use serde_json::Value;

/// Stable error codes. Mirrored in `@vantail/shared`.
pub mod code {
    pub const UNKNOWN_METHOD: &str = "UNKNOWN_METHOD";
    pub const INVALID_PARAMS: &str = "INVALID_PARAMS";
    pub const PERMISSION_DENIED: &str = "PERMISSION_DENIED";
    pub const NOT_FOUND: &str = "NOT_FOUND";
    pub const ALREADY_EXISTS: &str = "ALREADY_EXISTS";
    pub const IO_ERROR: &str = "IO_ERROR";
    pub const INVALID_UTF8: &str = "INVALID_UTF8";
    pub const UNSUPPORTED: &str = "UNSUPPORTED";
    pub const INTERNAL: &str = "INTERNAL";
    /// The caller abandoned the request before it answered.
    pub const CANCELLED: &str = "CANCELLED";
}

#[derive(Debug, Clone, Serialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ApiError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn unknown_method(method: &str) -> Self {
        Self::new(code::UNKNOWN_METHOD, format!("Unknown method `{method}`"))
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(code::INVALID_PARAMS, message)
    }

    pub fn denied(message: impl Into<String>) -> Self {
        Self::new(code::PERMISSION_DENIED, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(code::INTERNAL, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(code::UNSUPPORTED, message)
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(code::CANCELLED, message)
    }

    /// Map an `io::Error` onto a code the SDK can branch on.
    pub fn io(context: &str, err: std::io::Error) -> Self {
        use std::io::ErrorKind;
        let code = match err.kind() {
            ErrorKind::NotFound => code::NOT_FOUND,
            ErrorKind::AlreadyExists => code::ALREADY_EXISTS,
            ErrorKind::PermissionDenied => code::PERMISSION_DENIED,
            ErrorKind::InvalidData => code::INVALID_UTF8,
            _ => code::IO_ERROR,
        };
        Self::new(code, format!("{context}: {err}"))
    }
}

pub type ApiResult = Result<Value, ApiError>;
