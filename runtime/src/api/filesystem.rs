//! `filesystem.*` - scoped file access.
//!
//! Everything here runs on a worker thread and every path goes through
//! [`Permissions::check_path`], which returns the normalised path that the
//! operation then uses. Handlers never touch the raw string from JavaScript.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{code, ApiError, ApiResult};
use crate::ipc::Request;
use crate::permissions::{Access, Permissions, RawPath};
use crate::state::Runtime;

#[derive(Deserialize)]
struct PathParams {
    path: RawPath,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteParams {
    path: RawPath,
    contents: String,
    /// Create missing parent directories first. Off by default so a typo in a
    /// path fails loudly instead of quietly building a directory tree.
    #[serde(default)]
    create_dirs: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecursiveParams {
    path: RawPath,
    #[serde(default)]
    recursive: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteBinaryParams {
    path: RawPath,
    /// Base64. See the note on `MAX_BINARY_BYTES`.
    data: String,
    #[serde(default)]
    create_dirs: bool,
}

#[derive(Deserialize)]
struct FromToParams {
    from: RawPath,
    to: RawPath,
}

/// Binary payloads cross the IPC boundary as base64 inside a JSON string,
/// which costs a third again in size and has to be built in memory on both
/// sides. That is fine for icons, documents and small media, and wrong for
/// gigabyte files - so there is a limit, and it says so.
const MAX_BINARY_BYTES: u64 = 64 * 1024 * 1024;

const BASE64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

pub fn dispatch(rt: &Runtime, method: &str, params: Value) -> ApiResult {
    match method {
        "filesystem.readText" => read_text(rt, params),
        "filesystem.writeText" => write_text(rt, params),
        "filesystem.appendText" => append_text(rt, params),
        "filesystem.readBinary" => read_binary(rt, params),
        "filesystem.writeBinary" => write_binary(rt, params),
        "filesystem.readDir" => list_dir(rt, params),
        "filesystem.exists" => exists(rt, params),
        "filesystem.stat" => stat(rt, params),
        "filesystem.mkdir" => make_dir(rt, params),
        "filesystem.remove" => remove_path(rt, params),
        "filesystem.copy" => copy(rt, params),
        "filesystem.rename" => rename(rt, params),
        _ => Err(ApiError::unknown_method(method)),
    }
}

fn read_text(rt: &Runtime, params: Value) -> ApiResult {
    let PathParams { path } = Request::params("filesystem.readText", params)?;
    let path = rt.permissions.check_path(&path, Access::Read)?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| ApiError::io(&format!("Could not read {}", path.display()), e))?;
    Ok(Value::from(text))
}

fn write_text(rt: &Runtime, params: Value) -> ApiResult {
    let WriteParams {
        path,
        contents,
        create_dirs,
    } = Request::params("filesystem.writeText", params)?;
    let path = rt.permissions.check_path(&path, Access::Write)?;
    if create_dirs {
        create_parent(&path)?;
    }
    std::fs::write(&path, contents)
        .map_err(|e| ApiError::io(&format!("Could not write {}", path.display()), e))?;
    Ok(Value::Null)
}

fn append_text(rt: &Runtime, params: Value) -> ApiResult {
    use std::io::Write;
    let WriteParams { path, contents, .. } = Request::params("filesystem.appendText", params)?;
    let path = rt.permissions.check_path(&path, Access::Write)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| ApiError::io(&format!("Could not open {}", path.display()), e))?;
    file.write_all(contents.as_bytes())
        .map_err(|e| ApiError::io(&format!("Could not append to {}", path.display()), e))?;
    Ok(Value::Null)
}

fn read_binary(rt: &Runtime, params: Value) -> ApiResult {
    let PathParams { path } = Request::params("filesystem.readBinary", params)?;
    let path = rt.permissions.check_path(&path, Access::Read)?;

    let size = std::fs::metadata(&path)
        .map_err(|e| ApiError::io(&format!("Could not read {}", path.display()), e))?
        .len();
    if size > MAX_BINARY_BYTES {
        return Err(too_large(&path, size));
    }

    let bytes = std::fs::read(&path)
        .map_err(|e| ApiError::io(&format!("Could not read {}", path.display()), e))?;
    Ok(json!(BASE64.encode(bytes)))
}

fn write_binary(rt: &Runtime, params: Value) -> ApiResult {
    let WriteBinaryParams {
        path,
        data,
        create_dirs,
    } = Request::params("filesystem.writeBinary", params)?;
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| ApiError::invalid_params(format!("`data` is not valid base64: {e}")))?;

    let path = rt.permissions.check_path(&path, Access::Write)?;
    if bytes.len() as u64 > MAX_BINARY_BYTES {
        return Err(too_large(&path, bytes.len() as u64));
    }
    if create_dirs {
        create_parent(&path)?;
    }
    std::fs::write(&path, bytes)
        .map_err(|e| ApiError::io(&format!("Could not write {}", path.display()), e))?;
    Ok(Value::Null)
}

/// Create the directories `path` will live in, for a write that asked to.
fn create_parent(path: &Path) -> Result<(), ApiError> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(parent)
        .map_err(|e| ApiError::io(&format!("Could not create {}", parent.display()), e))
}

fn list_dir(rt: &Runtime, params: Value) -> ApiResult {
    let PathParams { path } = Request::params("filesystem.readDir", params)?;
    let path = rt.permissions.check_path(&path, Access::Read)?;
    read_dir(&path)
}

fn exists(rt: &Runtime, params: Value) -> ApiResult {
    let PathParams { path } = Request::params("filesystem.exists", params)?;
    // Existence is information, so it needs the same permission a read would
    // need. Otherwise this becomes a way to probe the disk.
    let path = rt.permissions.check_path(&path, Access::Read)?;
    Ok(json!(path.exists()))
}

fn stat(rt: &Runtime, params: Value) -> ApiResult {
    let PathParams { path } = Request::params("filesystem.stat", params)?;
    let path = rt.permissions.check_path(&path, Access::Read)?;
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|e| ApiError::io(&format!("Could not stat {}", path.display()), e))?;
    Ok(describe(&path, &metadata))
}

fn make_dir(rt: &Runtime, params: Value) -> ApiResult {
    let RecursiveParams { path, recursive } = Request::params("filesystem.mkdir", params)?;
    let path = rt.permissions.check_path(&path, Access::Write)?;
    let created = if recursive {
        std::fs::create_dir_all(&path)
    } else {
        std::fs::create_dir(&path)
    };
    created.map_err(|e| ApiError::io(&format!("Could not create {}", path.display()), e))?;
    Ok(Value::Null)
}

fn remove_path(rt: &Runtime, params: Value) -> ApiResult {
    let RecursiveParams { path, recursive } = Request::params("filesystem.remove", params)?;
    let path = rt.permissions.check_path(&path, Access::Write)?;
    remove(&path, recursive)
}

fn copy(rt: &Runtime, params: Value) -> ApiResult {
    let FromToParams { from, to } = Request::params("filesystem.copy", params)?;
    // Copying reads the source and writes the destination.
    let (from, to) = check_pair(&rt.permissions, &from, &to, Access::Read)?;
    std::fs::copy(&from, &to)
        .map_err(|e| ApiError::io(&format!("Could not copy {}", from.display()), e))?;
    Ok(Value::Null)
}

fn rename(rt: &Runtime, params: Value) -> ApiResult {
    let FromToParams { from, to } = Request::params("filesystem.rename", params)?;
    // Renaming removes the original, so the source needs write too.
    let (from, to) = check_pair(&rt.permissions, &from, &to, Access::Write)?;
    std::fs::rename(&from, &to)
        .map_err(|e| ApiError::io(&format!("Could not rename {}", from.display()), e))?;
    Ok(Value::Null)
}

/// Check both sides of a two-path operation, and return both checked paths.
///
/// Named rather than inline because the interesting part is `from_access`, and
/// getting it wrong is invisible: `copy` reads the source, `rename` unlinks it,
/// so `rename` needs write on a path `copy` only needs to read. A version that
/// checks only the destination, or checks the source as a read, still copies
/// and renames correctly for every file the caller was allowed to touch. It
/// fails only for the files it was supposed to stop, which is the failure
/// nothing notices.
///
/// The destination is always a write. There is no operation here where it is
/// not.
fn check_pair(
    permissions: &Permissions,
    from: &RawPath,
    to: &RawPath,
    from_access: Access,
) -> Result<(PathBuf, PathBuf), ApiError> {
    let from = permissions.check_path(from, from_access)?;
    let to = permissions.check_path(to, Access::Write)?;
    Ok((from, to))
}

fn too_large(path: &Path, size: u64) -> ApiError {
    ApiError::new(
        code::IO_ERROR,
        format!(
            "{} is {} MB; binary calls are limited to {} MB because the data \
             travels as base64 over the IPC channel.",
            path.display(),
            size / (1024 * 1024),
            MAX_BINARY_BYTES / (1024 * 1024)
        ),
    )
}

fn read_dir(path: &Path) -> ApiResult {
    let entries = std::fs::read_dir(path)
        .map_err(|e| ApiError::io(&format!("Could not read {}", path.display()), e))?;

    let mut out = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|e| ApiError::io(&format!("Could not read {}", path.display()), e))?;
        let entry_path = entry.path();

        // `file_type` does not follow symlinks, so a link to a directory is
        // reported as a link rather than silently as its target.
        let (is_dir, is_file, is_symlink) = match entry.file_type() {
            Ok(kind) => (kind.is_dir(), kind.is_file(), kind.is_symlink()),
            Err(_) => (false, false, false),
        };

        out.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry_path.to_string_lossy(),
            "isDirectory": is_dir,
            "isFile": is_file,
            "isSymlink": is_symlink,
        }));
    }

    out.sort_by(|a, b| {
        let key = listing_order;
        key(a).cmp(&key(b))
    });

    Ok(Value::Array(out))
}

fn remove(path: &PathBuf, recursive: bool) -> ApiResult {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| ApiError::io(&format!("Could not remove {}", path.display()), e))?;

    // A symlink is removed as a link, never followed - otherwise `remove` on a
    // link inside an allowed directory would delete something outside it.
    let removed = if metadata.is_dir() {
        if recursive {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_dir(path)
        }
    } else {
        std::fs::remove_file(path)
    };

    removed.map_err(|e| {
        if metadata.is_dir() && !recursive && e.kind() != std::io::ErrorKind::NotFound {
            ApiError::new(
                code::IO_ERROR,
                format!(
                    "{} is not empty. Pass `{{ recursive: true }}` to remove it and its contents.",
                    path.display()
                ),
            )
        } else {
            ApiError::io(&format!("Could not remove {}", path.display()), e)
        }
    })?;
    Ok(Value::Null)
}

fn describe(path: &Path, metadata: &std::fs::Metadata) -> Value {
    json!({
        "path": path.to_string_lossy(),
        "isDirectory": metadata.is_dir(),
        "isFile": metadata.is_file(),
        "isSymlink": metadata.file_type().is_symlink(),
        "size": metadata.len(),
        "readonly": metadata.permissions().readonly(),
        "modifiedAt": epoch_millis(metadata.modified()),
        "createdAt": epoch_millis(metadata.created()),
    })
}

/// Milliseconds since the Unix epoch, or `null` when the platform does not
/// record the timestamp. `Date` in JavaScript takes this directly.
fn epoch_millis(time: std::io::Result<SystemTime>) -> Value {
    let Ok(time) = time else {
        return Value::Null;
    };
    match time.duration_since(UNIX_EPOCH) {
        Ok(since) => json!(since.as_millis() as u64),
        Err(_) => Value::Null,
    }
}

/// Directories first, then by name regardless of case.
fn listing_order(entry: &Value) -> (bool, String) {
    let is_directory = match entry["isDirectory"].as_bool() {
        Some(is_directory) => is_directory,
        None => false,
    };
    let name = match entry["name"].as_str() {
        Some(name) => name.to_lowercase(),
        None => String::new(),
    };
    (!is_directory, name)
}

#[cfg(test)]
mod tests {
    //! The two-path operations.
    //!
    //! `copy` and `rename` are where a missing check is easiest to introduce
    //! and hardest to see, because the wrong version still works for every
    //! file the caller was allowed to touch. These pin which access each side
    //! demands, which is the part a reader cannot verify by looking.

    use super::*;
    use crate::permissions::{
        normalize, FilesystemConfig, PathScopeConfig, PermissionsConfig, RawPath, Vars,
    };

    fn permissions(read: Vec<String>, write: Vec<String>) -> Permissions {
        let vars = Vars::resolve("dev.vantail.test", Path::new("/tmp"));
        Permissions::compile(
            &PermissionsConfig {
                filesystem: FilesystemConfig {
                    read: PathScopeConfig::Patterns(read),
                    write: PathScopeConfig::Patterns(write),
                    ..FilesystemConfig::default()
                },
                ..PermissionsConfig::default()
            },
            &vars,
        )
        .expect("permissions compile")
    }

    /// A base directory in the same form `check_path` will produce.
    ///
    /// Through `normalize` rather than `canonicalize`, because the scope
    /// patterns below are built from this string and then compared against
    /// whatever `check_path` returns. On Windows `canonicalize` alone returns
    /// a verbatim `\\?\C:\...` path, and a pattern built from that matches
    /// nothing `normalize` ever produces - which is exactly how these tests
    /// first failed on Windows while passing everywhere else.
    fn temp_dir() -> PathBuf {
        normalize(&std::env::temp_dir()).expect("the temp directory normalises")
    }

    #[test]
    fn rename_denies_a_source_outside_the_write_scope() {
        // The case a careless implementation gets wrong: the destination is
        // perfectly legal, so checking only the destination passes. Renaming
        // unlinks the source, so this would move a file out of a directory
        // the application was never allowed to write to.
        let base = temp_dir();
        let permissions = permissions(
            vec![format!("{}/**", base.display())],
            vec![format!("{}/allowed/**", base.display())],
        );

        let outside = RawPath::new(format!("{}/elsewhere/notes.txt", base.display()));
        let inside = RawPath::new(format!("{}/allowed/notes.txt", base.display()));

        let error = check_pair(&permissions, &outside, &inside, Access::Write)
            .expect_err("renamed a file out of a directory that is not writable");
        assert_eq!(error.code, code::PERMISSION_DENIED);
    }

    #[test]
    fn copy_allows_the_same_source_rename_refuses() {
        // The pair that shows the two are not interchangeable. Reading a file
        // to copy it elsewhere is allowed; the same file cannot be renamed,
        // because that removes the original.
        let base = temp_dir();
        let permissions = permissions(
            vec![format!("{}/**", base.display())],
            vec![format!("{}/allowed/**", base.display())],
        );

        let source = RawPath::new(format!("{}/elsewhere/notes.txt", base.display()));
        let destination = RawPath::new(format!("{}/allowed/copy.txt", base.display()));

        assert!(check_pair(&permissions, &source, &destination, Access::Read).is_ok());
        assert!(check_pair(&permissions, &source, &destination, Access::Write).is_err());
    }

    #[test]
    fn a_legal_source_still_needs_a_legal_destination() {
        // The other half: a writable source does not license writing anywhere.
        let base = temp_dir();
        let permissions = permissions(
            vec![format!("{}/**", base.display())],
            vec![format!("{}/allowed/**", base.display())],
        );

        let source = RawPath::new(format!("{}/allowed/notes.txt", base.display()));
        let destination = RawPath::new(format!("{}/elsewhere/notes.txt", base.display()));

        let error = check_pair(&permissions, &source, &destination, Access::Write)
            .expect_err("wrote outside the write scope");
        assert_eq!(error.code, code::PERMISSION_DENIED);
    }

    #[test]
    fn both_returned_paths_are_the_normalised_ones() {
        // Rule 2 for two-path operations: what was checked is what gets used,
        // on both sides. A `..` that survived into either return value would
        // mean the check and the rename disagreed about one of them.
        let base = temp_dir();
        let permissions = permissions(
            vec![format!("{}/**", base.display())],
            vec![format!("{}/**", base.display())],
        );

        let from = RawPath::new(format!("{}/allowed/../a.txt", base.display()));
        let to = RawPath::new(format!("{}/allowed/../b.txt", base.display()));

        let (from, to) = check_pair(&permissions, &from, &to, Access::Write).expect("allowed");
        assert_eq!(from, base.join("a.txt"));
        assert_eq!(to, base.join("b.txt"));
    }
}
