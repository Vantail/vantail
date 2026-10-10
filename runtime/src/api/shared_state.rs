//! `sharedState.*` - a keyed, observable store shared by every window.
//!
//! The runtime is the authority: writes go renderer -> runtime -> all
//! renderers, so there is no "which window wins?" race. Last write wins.
//!
//! This complements `app.emit` / `app.listen` rather than replacing them:
//! those stay the low-level fire-and-forget bus, while this is a keyed store
//! with read-before-write semantics and change subscriptions. Both ride the
//! same transport - pushes go out as `sharedState.changed` events over the
//! existing `Outgoing::Event` channel. No new IPC channel, no WebSocket, no
//! `MessagePort`.
//!
//! Values are JSON (`serde_json::Value`). Persistence is an optional JSON
//! file under `$APPDATA`, hydrated on launch.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{code, ApiError, ApiResult};
use crate::ipc::{Event, Outgoing};
use crate::state::MainCtx;

const MAX_KEY_BYTES: usize = 256;
/// Keep one `set` bounded: this is a sync signal, not a database.
const MAX_VALUE_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
struct KeyParams {
    key: String,
}

#[derive(Deserialize)]
struct SetParams {
    key: String,
    value: Value,
}

/// In-memory map plus optional JSON persistence.
///
/// A plain `Mutex<HashMap>` is the whole store: no state-management crate,
/// minimal binary growth.
pub struct SharedState {
    inner: Mutex<HashMap<String, Value>>,
    persist_to: Option<PathBuf>,
}

impl Default for SharedState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            persist_to: None,
        }
    }
}

impl SharedState {
    pub fn new(persist: bool, identifier: &str) -> Self {
        let persist_to = persist.then(|| persist_path(identifier)).flatten();
        let mut initial = HashMap::new();
        if let Some(path) = &persist_to {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&text) {
                    for (k, v) in map {
                        initial.insert(k, v);
                    }
                }
            }
        }
        Self {
            inner: Mutex::new(initial),
            persist_to,
        }
    }

    fn get_value(&self, key: &str) -> Option<Value> {
        self.inner
            .lock()
            .expect("shared state poisoned")
            .get(key)
            .cloned()
    }

    fn set_value(&self, key: &str, value: Value) -> Result<(), ApiError> {
        // Serialise under the lock so two concurrent writes cannot interleave
        // a half-written file.
        let (snapshot, path) = {
            let mut map = self.inner.lock().expect("shared state poisoned");
            map.insert(key.to_string(), value);
            let path = self.persist_to.clone();
            if path.is_none() {
                return Ok(());
            }
            let snapshot = serde_json::to_string(&*map).map_err(|e| {
                ApiError::new(
                    code::SHARED_STATE_NOT_SERIALIZABLE,
                    format!("Shared state value for `{key}` is not serializable: {e}"),
                )
            })?;
            (snapshot, path.expect("checked above"))
        };
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return Err(ApiError::new(
                    code::SHARED_STATE_PERSIST_FAILED,
                    format!("Could not persist shared state: {e}"),
                ));
            }
        }
        std::fs::write(&path, snapshot).map_err(|e| {
            ApiError::new(
                code::SHARED_STATE_PERSIST_FAILED,
                format!("Could not persist shared state: {e}"),
            )
        })?;
        Ok(())
    }
}

fn persist_path(identifier: &str) -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(identifier).join("shared-state.json"))
}

/// Resolve/validate the key first, then check permission, then act.
fn check_key(key: &str) -> Result<(), ApiError> {
    if key.is_empty() {
        return Err(ApiError::invalid_params(
            "A shared state key cannot be empty",
        ));
    }
    if key.len() > MAX_KEY_BYTES {
        return Err(ApiError::invalid_params(format!(
            "A shared state key may be at most {MAX_KEY_BYTES} bytes"
        )));
    }
    if key.chars().any(|c| c.is_control()) {
        return Err(ApiError::invalid_params(
            "A shared state key cannot contain control characters",
        ));
    }
    Ok(())
}

fn check_value(value: &Value) -> Result<(), ApiError> {
    // `Value` is already JSON by construction, but `set` must still refuse
    // what cannot cross the boundary or be persisted: overly large payloads
    // and (defensively) anything that fails to serialise.
    let encoded = serde_json::to_string(value).map_err(|e| {
        ApiError::new(
            code::SHARED_STATE_NOT_SERIALIZABLE,
            format!("Shared state value is not JSON-serializable: {e}"),
        )
    })?;
    if encoded.len() > MAX_VALUE_BYTES {
        return Err(ApiError::new(
            code::SHARED_STATE_NOT_SERIALIZABLE,
            format!(
                "Shared state value exceeds {MAX_VALUE_BYTES} bytes ({})",
                encoded.len()
            ),
        ));
    }
    Ok(())
}

pub fn dispatch(ctx: &mut MainCtx<'_>, method: &str, params: Value) -> ApiResult {
    match method {
        "sharedState.get" => {
            // `default` needs custom handling: missing vs explicit `null`
            // differ, and an absent default must not be written.
            let raw: Value = params;
            let key = raw
                .get("key")
                .and_then(|k| k.as_str())
                .ok_or_else(|| {
                    ApiError::invalid_params("Bad params for `sharedState.get`: missing `key`")
                })?
                .to_string();
            check_key(&key)?;
            ctx.rt.permissions.check_shared_read("sharedState.get")?;
            let has_default = raw.get("default").is_some();
            let default = raw.get("default").cloned().unwrap_or(Value::Null);
            match ctx.rt.shared_state.get_value(&key) {
                Some(value) => Ok(value),
                None if has_default => Ok(default),
                None => Ok(Value::Null),
            }
        }
        "sharedState.set" => {
            let SetParams { key, value } = crate::ipc::Request::params(method, params)?;
            check_key(&key)?;
            ctx.rt.permissions.check_shared_write(&key)?;
            check_value(&value)?;
            ctx.rt.shared_state.set_value(&key, value.clone())?;
            // Broadcast to every window, including the caller.
            ctx.windows.deliver(
                None,
                &Outgoing::Event(Event::new(
                    "sharedState.changed",
                    json!({ "key": key, "value": value }),
                )),
            );
            Ok(Value::Null)
        }
        "sharedState.subscribe" => {
            // Registers interest: permission-checked, answers with the current
            // value so late subscribers get it immediately. Subsequent changes
            // arrive as `sharedState.changed` events over the same transport
            // `app.emit` uses. The SDK wraps this into a callback API.
            let KeyParams { key } = crate::ipc::Request::params(method, params)?;
            check_key(&key)?;
            ctx.rt
                .permissions
                .check_shared_read("sharedState.subscribe")?;
            Ok(ctx.rt.shared_state.get_value(&key).unwrap_or(Value::Null))
        }
        _ => Err(ApiError::unknown_method(method)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::{Permissions, PermissionsConfig, SharedStateConfig, Vars};
    use std::path::Path;

    #[test]
    fn key_globs_stop_at_dot_boundaries() {
        use crate::permissions::shared_key_matches;
        assert!(shared_key_matches("demo.*", "demo.counter"));
        assert!(!shared_key_matches("demo.*", "demo.counter.extra"));
        assert!(shared_key_matches("demo.**", "demo.counter.extra"));
        assert!(shared_key_matches("demo.**", "demo.counter"));
        assert!(!shared_key_matches("*", "demo.counter"));
        assert!(shared_key_matches("*", "top"));
        assert!(shared_key_matches("user.*.name", "user.a.name"));
        assert!(!shared_key_matches("user.*.name", "user.a.b.name"));
        assert!(shared_key_matches("user.**.name", "user.a.b.name"));
    }

    #[test]
    fn empty_keys_are_rejected() {
        assert!(check_key("").is_err());
        assert!(check_key("demo.counter").is_ok());
    }

    #[test]
    fn persist_requires_writable_config() {
        let vars = Vars::resolve("dev.vantail.test", Path::new("/tmp"));
        let mut config = PermissionsConfig::default();
        config.shared_state = SharedStateConfig {
            read: true,
            write: vec![],
            persist: true,
        };
        assert!(Permissions::compile(&config, &vars).is_err());
    }

    #[test]
    fn oversized_values_are_rejected() {
        let big = Value::String("x".repeat(MAX_VALUE_BYTES + 1));
        assert_eq!(
            check_value(&big).unwrap_err().code,
            code::SHARED_STATE_NOT_SERIALIZABLE
        );
    }
}
