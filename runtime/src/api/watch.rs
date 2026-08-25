//! `filesystem.watch` - being told when a file changes.
//!
//! There is no browser API for this. A page can read a file it was given, but
//! it cannot learn that the file changed underneath it, so an application that
//! wants to react to an editor saving - or to a log being appended to - has to
//! poll, which is both slow to notice and constant work.
//!
//! A watch is scoped exactly like a read: the path goes through the same
//! permission check, so watching cannot be used to learn about a directory an
//! application is not allowed to read.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use notify::{RecursiveMode, Watcher};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::ipc::{Event, Outgoing, Request};
use crate::permissions::Access;
use crate::state::Runtime;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchParams {
    path: String,
    /// Watch everything underneath a directory too. Default `false`.
    #[serde(default)]
    recursive: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnwatchParams {
    id: String,
}

/// Live watches, by the id handed back to the application.
#[derive(Default)]
pub struct State {
    watches: Mutex<HashMap<String, Box<dyn Watcher + Send>>>,
    next: Mutex<u64>,
}

impl State {
    fn take_id(&self) -> String {
        let mut next = self.next.lock().expect("watch ids poisoned");
        *next += 1;
        format!("watch-{next}")
    }
}

pub fn dispatch(rt: &Arc<Runtime>, source: &str, method: &str, params: Value) -> ApiResult {
    match method {
        "filesystem.watch" => {
            let WatchParams { path, recursive } = Request::params(method, params)?;
            // The same check a read goes through, on the resolved path.
            let resolved = rt.permissions.check_path(&path, Access::Read)?;
            start(rt, source, resolved, recursive)
        }

        "filesystem.unwatch" => {
            let UnwatchParams { id } = Request::params(method, params)?;
            let removed = rt
                .watch
                .watches
                .lock()
                .expect("watches poisoned")
                .remove(&id);

            match removed {
                // Dropping the watcher is what stops it.
                Some(_) => Ok(Value::Null),
                None => Err(ApiError::new(
                    crate::error::code::NOT_FOUND,
                    format!("No watch named `{id}`"),
                )),
            }
        }

        "filesystem.watches" => {
            let watches = rt.watch.watches.lock().expect("watches poisoned");
            let mut ids: Vec<_> = watches.keys().cloned().collect();
            ids.sort();
            Ok(json!(ids))
        }

        _ => Err(ApiError::unknown_method(method)),
    }
}

fn start(rt: &Arc<Runtime>, source: &str, path: PathBuf, recursive: bool) -> ApiResult {
    let id = rt.watch.take_id();

    let rt_for_thread = rt.clone();
    let window = source.to_string();
    let watch_id = id.clone();
    let watched = path.clone();

    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else {
            return;
        };

        let Some(kind) = describe(&event.kind) else {
            return;
        };

        // A change reports the paths it touched, which for a recursive watch
        // is not the path that was asked for.
        for changed in &event.paths {
            rt_for_thread.send(
                Some(window.clone()),
                Outgoing::Event(Event::new(
                    "filesystem.changed",
                    json!({
                        "id": watch_id,
                        "kind": kind,
                        "path": changed.to_string_lossy(),
                        "watching": watched.to_string_lossy(),
                    }),
                )),
            );
        }
    })
    .map_err(|e| ApiError::internal(format!("Could not start watching: {e}")))?;

    let mode = if recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };

    watcher
        .watch(&path, mode)
        .map_err(|e| ApiError::internal(format!("Could not watch {}: {e}", path.display())))?;

    rt.watch
        .watches
        .lock()
        .expect("watches poisoned")
        .insert(id.clone(), Box::new(watcher));

    Ok(json!({ "id": id, "path": path.to_string_lossy(), "recursive": recursive }))
}

/// The three things an application actually reacts to.
///
/// notify reports far more than this - attribute changes, individual rename
/// halves, platform-specific kinds - and an application that wants to reload a
/// file wants to know it changed, not which flavour of change it was.
fn describe(kind: &notify::EventKind) -> Option<&'static str> {
    use notify::EventKind;
    match kind {
        EventKind::Create(_) => Some("created"),
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => Some("renamed"),
        EventKind::Modify(_) => Some("modified"),
        EventKind::Remove(_) => Some("removed"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    /// The backend itself, with no Vantail around it.
    ///
    /// If this passes and the integration test does not, the fault is in the
    /// plumbing rather than in the watching.
    #[test]
    fn a_watcher_reports_a_file_created_under_it() {
        let dir = std::env::temp_dir().join(format!("vantail-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");

        let (tx, rx) = mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    let _ = tx.send(event);
                }
            })
            .expect("watcher");

        watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .expect("watch");

        // FSEvents needs a moment to be listening before the change happens.
        std::thread::sleep(Duration::from_millis(500));
        std::fs::write(dir.join("note.txt"), "hello").expect("write");

        let event = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the watcher reported nothing");

        assert!(
            event
                .paths
                .iter()
                .any(|path| path.to_string_lossy().ends_with("note.txt")),
            "reported {:?}",
            event.paths
        );
        assert!(
            describe(&event.kind).is_some(),
            "unmapped kind {:?}",
            event.kind
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
