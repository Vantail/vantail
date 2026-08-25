use serde::Deserialize;
use serde_json::Value;

/// A single call from JavaScript.
///
/// `params` is kept as raw JSON and decoded by the handler that owns the
/// method, so adding an API never means touching the router's types.
#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl Request {
    /// Decode `params` into the shape a handler expects.
    pub fn params<T: serde::de::DeserializeOwned>(
        method: &str,
        params: Value,
    ) -> Result<T, crate::error::ApiError> {
        serde_json::from_value(params).map_err(|e| {
            crate::error::ApiError::invalid_params(format!("Bad params for `{method}`: {e}"))
        })
    }
}
