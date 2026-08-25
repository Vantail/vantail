//! `updater.*` - replacing the application with a newer one.
//!
//! The shape is deliberately three steps rather than one, because they fail
//! for different reasons and an application usually wants to say something
//! different about each: `check` is a network call, `download` can take
//! minutes and reports progress, and `install` restarts the app.
//!
//! Nothing is extracted before its signature has been verified against the
//! public key baked into `vantail.config.ts`. An attacker who controls the
//! update endpoint - or the network between it and the user - can therefore
//! stop an update, but cannot substitute one.

pub mod version;

#[cfg(feature = "updater")]
mod imp;

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::state::MainCtx;

/// A verified archive, waiting to be installed.
pub struct Pending {
    pub version: String,
    pub archive: PathBuf,
}

#[derive(Default)]
pub struct State {
    pending: Mutex<Option<Pending>>,
}

impl State {
    pub fn set(&self, pending: Pending) {
        *self.pending.lock().expect("update state poisoned") = Some(pending);
    }

    pub fn take(&self) -> Option<Pending> {
        self.pending.lock().expect("update state poisoned").take()
    }

    pub fn version(&self) -> Option<String> {
        self.pending
            .lock()
            .expect("update state poisoned")
            .as_ref()
            .map(|pending| pending.version.clone())
    }
}

/// The key this build looks for in a manifest's `platforms` map.
pub fn target() -> String {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    format!("{platform}-{}", std::env::consts::ARCH)
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Route an `updater.*` call.
///
/// `None` means the response arrives later, from the download thread.
#[cfg(feature = "updater")]
pub fn dispatch(ctx: &mut MainCtx<'_>, id: &str, method: &str, params: Value) -> Option<ApiResult> {
    imp::dispatch(ctx, id, method, params)
}

/// The same entry point for builds without the `updater` feature, so an
/// application gets a clear answer rather than `UNKNOWN_METHOD`.
#[cfg(not(feature = "updater"))]
pub fn dispatch(
    _ctx: &mut MainCtx<'_>,
    _id: &str,
    _method: &str,
    _params: Value,
) -> Option<ApiResult> {
    Some(Err(crate::error::ApiError::unsupported(
        "This runtime was built without the updater. Rebuild with the `updater` feature enabled.",
    )))
}

/// Where this application lives on disk, and where its executable sits inside
/// that.
struct Installation {
    root: PathBuf,
    executable_within_root: PathBuf,
}

impl Installation {
    fn locate() -> Result<Self, ApiError> {
        let exe = std::env::current_exe()
            .map_err(|e| ApiError::io("Could not locate the running executable", e))?;

        // macOS: .../My App.app/Contents/MacOS/exe -> the bundle is the unit
        // that gets replaced.
        #[cfg(target_os = "macos")]
        {
            let mut ancestor = exe.as_path();
            while let Some(parent) = ancestor.parent() {
                if parent.extension().is_some_and(|ext| ext == "app") {
                    return Ok(Self {
                        executable_within_root: exe
                            .strip_prefix(parent)
                            .unwrap_or(std::path::Path::new("Contents/MacOS"))
                            .to_path_buf(),
                        root: parent.to_path_buf(),
                    });
                }
                ancestor = parent;
            }
        }

        // Portable layout: the executable sits at the top of its own folder.
        let root = exe
            .parent()
            .ok_or_else(|| ApiError::internal("The executable has no containing directory"))?
            .to_path_buf();
        let executable_within_root = exe
            .file_name()
            .map(PathBuf::from)
            .ok_or_else(|| ApiError::internal("The executable has no file name"))?;

        Ok(Self {
            root,
            executable_within_root,
        })
    }
}

/// Remove the previous version, once at startup.
///
/// Deleting it during `install` is not possible: the process doing the
/// deleting is running out of it.
pub fn clean_previous() {
    let Ok(installed) = Installation::locate() else {
        return;
    };

    #[cfg(not(windows))]
    let _ = std::fs::remove_dir_all(installed.root.with_extension("old"));

    // Windows replaces the application's files individually rather than
    // renaming the directory around them, so the leftovers are a `<name>.old`
    // beside each one.
    #[cfg(windows)]
    remove_retired(&installed.root);
}

/// Remove the `<name>.old` entries a Windows install left behind.
///
/// Only ones whose replacement is present, so a file an application happens
/// to have named `notes.old` survives - the updater never retires a name
/// without putting something back under it.
#[cfg(windows)]
fn remove_retired(root: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Some(stem) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".old"))
        else {
            continue;
        };

        if root.join(stem).exists() {
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}
