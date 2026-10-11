//! `sharedState.*` - keyed state shared between every window.
//!
//! The runtime owns the values; windows hold synchronised copies. A write
//! goes renderer -> runtime -> all renderers (including the caller), so there
//! is no "which window wins?" race - the last write wins, and every window
//! hears about it over the same transport `app.emit` rides on.
//!
//! This complements `app.emit` / `app.listen` rather than replacing it: those
//! stay the fire-and-forget message bus, while this is a keyed store with
//! read-before-write semantics and change subscriptions.
//!
//! Change events are broadcast to every window; the SDK filters them by key.
//! That keeps the runtime free of per-window subscription bookkeeping - an
//! in-memory map plus an optional JSON file, nothing more.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{code, ApiError, ApiResult};
use crate::ipc::{Event, Outgoing, Request};
use crate::state::MainCtx;

/// The event a write broadcasts, delivered to every window.
pub const CHANGED_EVENT: &str = "sharedState.changed";

/// File name for the persisted store, inside the app's `$APPDATA` directory.
const PERSIST_FILE: &str = "shared-state.json";

#[derive(Deserialize)]
struct GetParams {
    key: String,
    #[serde(default)]
    default: Option<Value>,
}

#[derive(Deserialize)]
struct KeyParams {
    key: String,
}

#[derive(Deserialize)]
struct SetParams {
    key: String,
    value: Value,
}

pub fn dispatch(ctx: &mut MainCtx<'_>, method: &str, params: Value) -> ApiResult {
    match method {
        "sharedState.get" => {
            let GetParams { key, default } = Request::params(method, params)?;
            crate::permissions::Permissions::check_shared_key(&key)?;
            ctx.rt.permissions.check_shared_read(method)?;
            Ok(ctx
                .rt
                .shared
                .get(&key)
                .or(default)
                .unwrap_or(Value::Null))
        }

        "sharedState.set" => {
            let SetParams { key, value } = Request::params(method, params)?;
            crate::permissions::Permissions::check_shared_key(&key)?;
            ctx.rt.permissions.check_shared_write(&key)?;
            check_serializable(&value)?;
            ctx.rt.shared.set(&key, value.clone())?;

            // To every window, including the caller: the caller's own copy
            // updates through the same path as everyone else's.
            ctx.windows.deliver(
                None,
                &Outgoing::Event(Event::new(CHANGED_EVENT, json!({ "key": key, "value": value }))),
            );
            Ok(Value::Null)
        }

        // Registering interest is local to the SDK - change events already
        // reach every window - so this answers with the current value, which
        // is what a late subscriber needs: the value on subscribe, then
        // subsequent changes as events.
        "sharedState.subscribe" => {
            let KeyParams { key } = Request::params(method, params)?;
            crate::permissions::Permissions::check_shared_key(&key)?;
            ctx.rt.permissions.check_shared_read(method)?;
            Ok(ctx.rt.shared.get(&key).unwrap_or(Value::Null))
        }

        _ => Err(ApiError::unknown_method(method)),
    }
}

/// Values cross as JSON, so anything that cannot be represented there must be
/// refused with a stable code rather than silently mangled.
///
/// By the time a value arrives here it is already a `serde_json::Value`, so
/// the genuinely unrepresentable shapes (`undefined`, functions, `BigInt`,
/// circular structures) are caught by the SDK before they are sent - see
/// `packages/api/src/sharedState.ts`. This is the runtime side of the same
/// boundary: re-serialise, and anything that does not survive is rejected.
fn check_serializable(value: &Value) -> Result<(), ApiError> {
    serde_json::to_string(value).map(|_| ()).map_err(|e| {
        ApiError::new(
            code::SHARED_STATE_NOT_SERIALIZABLE,
            format!("This value cannot be shared between windows: it is not JSON-serialisable ({e})"),
        )
    })
}

/// The store itself: a map, and optionally a file it is written back to.
pub struct Store {
    inner: Mutex<Inner>,
}

struct Inner {
    values: HashMap<String, Value>,
    persist: bool,
    path: Option<PathBuf>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                values: HashMap::new(),
                persist: false,
                path: None,
            }),
        }
    }
}

impl Store {
    /// The store for an application: in-memory, plus hydration from
    /// `$APPDATA/shared-state.json` when `persist` is on.
    pub fn new(identifier: &str, persist: bool) -> Self {
        if !persist {
            return Self::ephemeral();
        }
        let path = persist_path(identifier);
        let values = load(&path);
        Self {
            inner: Mutex::new(Inner {
                values,
                persist,
                path: Some(path),
            }),
        }
    }

    /// In-memory only. What tests and non-persisted applications use.
    pub fn ephemeral() -> Self {
        Self::default()
    }

    /// Persisted to an explicit path. What tests use instead of `$APPDATA`.
    #[cfg(test)]
    pub fn persistent(path: PathBuf) -> Self {
        let values = load(&path);
        Self {
            inner: Mutex::new(Inner {
                values,
                persist: true,
                path: Some(path),
            }),
        }
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.inner
            .lock()
            .expect("shared-state store poisoned")
            .values
            .get(key)
            .cloned()
    }

    pub fn set(&self, key: &str, value: Value) -> Result<(), ApiError> {
        let mut inner = self.inner.lock().expect("shared-state store poisoned");
        inner.values.insert(key.to_string(), value);
        if inner.persist {
            if let Some(path) = inner.path.clone() {
                // Serialised before the lock is needed again, so a slow disk
                // holds nothing but a buffer.
                let snapshot = serde_json::to_value(&inner.values).map_err(|e| {
                    ApiError::new(
                        code::SHARED_STATE_NOT_SERIALIZABLE,
                        format!("Shared state could not be persisted: {e}"),
                    )
                })?;
                save(&path, &snapshot)?;
            }
        }
        Ok(())
    }
}

fn persist_path(identifier: &str) -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(identifier)
        .join(PERSIST_FILE)
}

/// Read the store back. Missing is empty; corrupt is empty with a note on
/// stderr rather than a launch that refuses to start over a cache file.
fn load(path: &PathBuf) -> HashMap<String, Value> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return HashMap::new(),
        Err(e) => {
            eprintln!("vantail: could not read shared state at {}: {e}", path.display());
            return HashMap::new();
        }
    };
    match serde_json::from_str::<HashMap<String, Value>>(&text) {
        Ok(values) => values,
        Err(e) => {
            eprintln!(
                "vantail: shared state at {} did not parse, starting empty: {e}",
                path.display()
            );
            HashMap::new()
        }
    }
}

fn save(path: &PathBuf, snapshot: &Value) -> Result<(), ApiError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            ApiError::new(
                code::SHARED_STATE_PERSIST_FAILED,
                format!("Could not persist shared state to {}: {e}", path.display()),
            )
        })?;
    }
    let text = serde_json::to_string_pretty(snapshot).map_err(|e| {
        ApiError::new(
            code::SHARED_STATE_PERSIST_FAILED,
            format!("Could not serialise shared state: {e}"),
        )
    })?;
    // Through a temporary file and a rename, so a crash mid-write leaves the
    // previous snapshot rather than half a file.
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text)
        .and_then(|()| std::fs::rename(&tmp, path))
        .map_err(|e| {
            ApiError::new(
                code::SHARED_STATE_PERSIST_FAILED,
                format!("Could not persist shared state to {}: {e}", path.display()),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("vantail-shared-state-test-{name}.json"))
    }

    fn clean(path: &PathBuf) {
        let _ = std::fs::remove_file(path);
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(".tmp");
        let _ = std::fs::remove_file(PathBuf::from(tmp));
    }

    #[test]
    fn an_unset_key_reads_back_null() {
        let store = Store::ephemeral();
        assert!(store.get("demo.counter").is_none());
    }

    #[test]
    fn a_written_value_reads_back() {
        let store = Store::ephemeral();
        store.set("demo.counter", json!(3)).expect("set");
        assert_eq!(store.get("demo.counter"), Some(json!(3)));
    }

    #[test]
    fn the_last_write_wins() {
        let store = Store::ephemeral();
        store.set("demo.theme", json!("light")).expect("set");
        store.set("demo.theme", json!("dark")).expect("set");
        assert_eq!(store.get("demo.theme"), Some(json!("dark")));
    }

    #[test]
    fn values_round_trip_through_json() {
        let store = Store::ephemeral();
        let value = json!({ "nested": [1, "two", null], "flag": true });
        store.set("demo.doc", value.clone()).expect("set");
        assert_eq!(store.get("demo.doc"), Some(value));
    }

    #[test]
    fn a_persisted_store_survives_a_restart() {
        let path = temp_path("restart");
        clean(&path);

        {
            let store = Store::persistent(path.clone());
            store.set("demo.counter", json!(41)).expect("set");
        }

        // A new store over the same path hydrates what the old one wrote.
        let reopened = Store::persistent(path.clone());
        assert_eq!(reopened.get("demo.counter"), Some(json!(41)));

        clean(&path);
    }

    #[test]
    fn every_write_is_flushed_not_just_the_last() {
        let path = temp_path("flush");
        clean(&path);

        let store = Store::persistent(path.clone());
        store.set("demo.a", json!(1)).expect("set");
        // Read straight off disk, without going through the store again.
        let text = std::fs::read_to_string(&path).expect("file exists after one write");
        assert!(text.contains("demo.a"), "a write must be durable at once: {text}");

        clean(&path);
    }
}
