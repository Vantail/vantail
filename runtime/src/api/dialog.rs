//! `dialog.*` - native file and message dialogs.
//!
//! These run on the event loop thread and block it for as long as the dialog
//! is open. That is the same thing a native modal does, and it keeps the
//! platform code to a single synchronous call.
//!
//! A successful pick also *grants* access to the chosen path (see
//! [`Permissions::grant_from_dialog`]). That is the point of the dialog: the
//! user deciding is the authorisation, so a tightly scoped `permissions`
//! block does not stop an app from opening the file its user just chose.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::ipc::Request;
use crate::permissions::Access;
use crate::state::{MainCtx, Runtime};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct FileParams {
    title: Option<String>,
    default_path: Option<String>,
    default_name: Option<String>,
    filters: Vec<Filter>,
    multiple: bool,
}

#[derive(Deserialize)]
struct Filter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MessageParams {
    title: Option<String>,
    message: String,
    /// `info` | `warning` | `error`
    kind: Option<String>,
    ok_label: Option<String>,
    cancel_label: Option<String>,
}

pub fn dispatch(ctx: &mut MainCtx<'_>, method: &str, params: Value) -> ApiResult {
    let rt = ctx.rt;
    rt.permissions.require(rt.permissions.dialog, method)?;

    match method {
        "dialog.openFile" => {
            let params: FileParams = Request::params(method, params)?;
            let dialog = file_dialog(&params);
            if params.multiple {
                let picked = dialog.pick_files().unwrap_or_default();
                Ok(json!(grant_all(rt, picked, Access::Read)))
            } else {
                Ok(match dialog.pick_file() {
                    Some(path) => json!(grant(rt, path, Access::Read)),
                    None => Value::Null,
                })
            }
        }

        "dialog.openDirectory" => {
            let params: FileParams = Request::params(method, params)?;
            let dialog = file_dialog(&params);
            if params.multiple {
                let picked = dialog.pick_folders().unwrap_or_default();
                Ok(json!(grant_all(rt, picked, Access::Read)))
            } else {
                Ok(match dialog.pick_folder() {
                    Some(path) => json!(grant(rt, path, Access::Read)),
                    None => Value::Null,
                })
            }
        }

        "dialog.saveFile" => {
            let params: FileParams = Request::params(method, params)?;
            Ok(match file_dialog(&params).save_file() {
                Some(path) => json!(grant(rt, path, Access::Write)),
                None => Value::Null,
            })
        }

        "dialog.message" => {
            let params: MessageParams = Request::params(method, params)?;
            message_dialog(&params).show();
            Ok(Value::Null)
        }

        "dialog.confirm" => {
            let params: MessageParams = Request::params(method, params)?;
            let buttons = match (&params.ok_label, &params.cancel_label) {
                (Some(ok), Some(cancel)) => {
                    rfd::MessageButtons::OkCancelCustom(ok.clone(), cancel.clone())
                }
                _ => rfd::MessageButtons::OkCancel,
            };
            let answer = message_dialog(&params).set_buttons(buttons).show();
            Ok(json!(accepted(&answer, params.ok_label.as_deref())))
        }

        _ => Err(ApiError::unknown_method(method)),
    }
}

/// Whether the user chose the affirmative button, whatever it was labelled.
fn accepted(answer: &rfd::MessageDialogResult, ok_label: Option<&str>) -> bool {
    match answer {
        rfd::MessageDialogResult::Ok | rfd::MessageDialogResult::Yes => true,
        rfd::MessageDialogResult::Custom(label) => Some(label.as_str()) == ok_label,
        _ => false,
    }
}

fn file_dialog(params: &FileParams) -> rfd::FileDialog {
    let mut dialog = rfd::FileDialog::new();

    if let Some(title) = &params.title {
        dialog = dialog.set_title(title);
    }
    if let Some(name) = &params.default_name {
        dialog = dialog.set_file_name(name);
    }
    if let Some(path) = &params.default_path {
        // Point at the containing directory when given a file path, which is
        // what "start me where this file lives" means to a user.
        let path = Path::new(path);
        let directory = if path.is_dir() {
            Some(path)
        } else {
            path.parent()
        };
        if let Some(directory) = directory.filter(|d| d.is_dir()) {
            dialog = dialog.set_directory(directory);
        }
    }
    for filter in &params.filters {
        dialog = dialog.add_filter(&filter.name, &filter.extensions);
    }

    dialog
}

fn message_dialog(params: &MessageParams) -> rfd::MessageDialog {
    let level = match params.kind.as_deref() {
        Some("warning") => rfd::MessageLevel::Warning,
        Some("error") => rfd::MessageLevel::Error,
        _ => rfd::MessageLevel::Info,
    };

    rfd::MessageDialog::new()
        .set_level(level)
        .set_title(params.title.as_deref().unwrap_or(""))
        .set_description(&params.message)
}

fn grant(rt: &Runtime, path: PathBuf, access: Access) -> String {
    rt.permissions.grant_from_dialog(&path, access);
    path.to_string_lossy().into_owned()
}

fn grant_all(rt: &Runtime, paths: Vec<PathBuf>, access: Access) -> Vec<String> {
    paths
        .into_iter()
        .map(|path| grant(rt, path, access))
        .collect()
}
