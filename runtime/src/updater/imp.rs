//! The parts of the updater that need a network stack and a signature
//! verifier. Compiled only with the `updater` feature.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::UpdaterConfig;
use crate::error::{ApiError, ApiResult};
use crate::ipc::{Event, Outgoing, Response};
use crate::state::{MainCtx, Runtime};
use crate::updater::{target, version, Installation, Pending};

const BASE64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// A ceiling on the download, so a hostile endpoint cannot fill the disk.
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

/// The manifest an application publishes at its update endpoint.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    pub_date: Option<String>,
    platforms: HashMap<String, Platform>,
}

#[derive(Debug, Clone, Deserialize)]
struct Platform {
    url: String,
    /// base64 ed25519 signature over the archive bytes.
    signature: String,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

pub fn dispatch(
    ctx: &mut MainCtx<'_>,
    id: &str,
    method: &str,
    _params: Value,
) -> Option<ApiResult> {
    if let Err(error) = ctx
        .rt
        .permissions
        .require(ctx.rt.permissions.updater, method)
    {
        return Some(Err(error));
    }

    let rt = ctx.rt.clone();
    let source = ctx.source.to_string();

    Some(match method {
        "updater.check" => check(&rt).map(|found| match found {
            Some(update) => update,
            None => json!({ "available": false, "currentVersion": rt.config.app.version }),
        }),

        "updater.download" => {
            start_download(&rt, id, &source);
            return None;
        }

        "updater.pending" => Ok(match rt.updates.version() {
            Some(version) => json!({ "ready": true, "version": version }),
            None => json!({ "ready": false }),
        }),

        "updater.install" => install(&rt),

        _ => Err(ApiError::unknown_method(method)),
    })
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

fn config(rt: &Runtime) -> Result<&UpdaterConfig, ApiError> {
    rt.config.updater.as_ref().ok_or_else(|| {
        ApiError::unsupported(
            "This application has no `updater` block in vantail.config.ts, so there is nothing to check.",
        )
    })
}

fn check(rt: &Runtime) -> Result<Option<Value>, ApiError> {
    let (manifest, _) = fetch_manifest(rt)?;
    let current = &rt.config.app.version;

    if !version::is_newer(&manifest.version, current) {
        return Ok(None);
    }

    let key = target();
    if !manifest.platforms.contains_key(&key) {
        return Err(ApiError::unsupported(format!(
            "Version {} does not publish a build for `{key}`",
            manifest.version
        )));
    }

    Ok(Some(json!({
        "available": true,
        "currentVersion": current,
        "version": manifest.version,
        "notes": manifest.notes,
        "pubDate": manifest.pub_date,
        "target": key,
    })))
}

fn fetch_manifest(rt: &Runtime) -> Result<(Manifest, UpdaterConfig), ApiError> {
    let config = config(rt)?.clone();
    let url = config
        .endpoint
        .replace("{{target}}", &target())
        .replace("{{arch}}", std::env::consts::ARCH)
        .replace("{{currentVersion}}", &rt.config.app.version);

    let agent = agent(config.timeout_ms);
    let mut response = agent
        .get(&url)
        .call()
        .map_err(|e| ApiError::internal(format!("Could not reach the update endpoint: {e}")))?;

    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|e| ApiError::internal(format!("Could not read the update manifest: {e}")))?;

    let manifest: Manifest = serde_json::from_str(&body)
        .map_err(|e| ApiError::internal(format!("The update manifest is not valid: {e}")))?;

    Ok((manifest, config))
}

fn agent(timeout_ms: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_millis(timeout_ms)))
        .build()
        .into()
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

fn start_download(rt: &Arc<Runtime>, request_id: &str, source: &str) {
    let worker_rt = Arc::clone(rt);
    let worker_id = request_id.to_string();
    let worker_source = source.to_string();

    let spawned = std::thread::Builder::new()
        .name("vantail-update".into())
        .spawn(move || {
            let result = download(&worker_rt, &worker_source);
            worker_rt.send(
                Some(worker_source),
                Outgoing::Response(Response::from_result(worker_id, result)),
            );
        });

    if let Err(error) = spawned {
        rt.send(
            Some(source.to_string()),
            Outgoing::Response(Response::from_result(
                request_id.to_string(),
                Err(ApiError::internal(format!(
                    "Could not start the download: {error}"
                ))),
            )),
        );
    }
}

fn download(rt: &Arc<Runtime>, source: &str) -> ApiResult {
    let (manifest, config) = fetch_manifest(rt)?;

    if !version::is_newer(&manifest.version, &rt.config.app.version) {
        return Err(ApiError::new(
            crate::error::code::NOT_FOUND,
            format!("{} is already the newest version", rt.config.app.version),
        ));
    }

    let key = target();
    let platform = manifest.platforms.get(&key).ok_or_else(|| {
        ApiError::unsupported(format!(
            "Version {} does not publish a build for `{key}`",
            manifest.version
        ))
    })?;

    let signature = decode_signature(&platform.signature)?;
    let verifier = verifying_key(&config.public_key)?;

    let bytes = fetch_archive(rt, source, &config, &platform.url)?;

    // Verified before anything is written where it could be executed.
    verifier.verify_strict(&bytes, &signature).map_err(|_| {
        ApiError::denied(
            "The downloaded update is not signed by this application's key. It has been discarded.",
        )
    })?;

    let archive = staging_dir(rt)?.join(format!("update-{}.tar.gz", manifest.version));
    std::fs::write(&archive, &bytes).map_err(|e| ApiError::io("Could not save the update", e))?;

    rt.updates.set(Pending {
        version: manifest.version.clone(),
        archive,
    });

    Ok(json!({ "ready": true, "version": manifest.version, "bytes": bytes.len() }))
}

fn fetch_archive(
    rt: &Arc<Runtime>,
    source: &str,
    config: &UpdaterConfig,
    url: &str,
) -> Result<Vec<u8>, ApiError> {
    let agent = agent(config.timeout_ms);
    let mut response = agent
        .get(url)
        .call()
        .map_err(|e| ApiError::internal(format!("Could not download the update: {e}")))?;

    let total: u64 = response
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);

    if total > MAX_ARCHIVE_BYTES {
        return Err(ApiError::internal(format!(
            "The update is {} MB, which is larger than this runtime will download",
            total / (1024 * 1024)
        )));
    }

    let mut reader = response.body_mut().as_reader();
    let mut bytes = Vec::with_capacity(total as usize);
    let mut buffer = [0_u8; 64 * 1024];
    let mut last_reported = 0_u64;

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| ApiError::io("The download was interrupted", e))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);

        if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
            return Err(ApiError::internal(
                "The update stopped being plausible: it exceeded the download limit",
            ));
        }

        // Report roughly every 256 KB rather than every chunk, so a fast
        // download does not spend its time serialising progress events.
        let downloaded = bytes.len() as u64;
        if downloaded - last_reported > 256 * 1024 {
            last_reported = downloaded;
            rt.send(
                Some(source.to_string()),
                Outgoing::Event(Event::new(
                    "updater.progress",
                    json!({ "downloaded": downloaded, "total": total }),
                )),
            );
        }
    }

    rt.send(
        Some(source.to_string()),
        Outgoing::Event(Event::new(
            "updater.progress",
            json!({ "downloaded": bytes.len(), "total": bytes.len() }),
        )),
    );

    Ok(bytes)
}

fn decode_signature(encoded: &str) -> Result<ed25519_dalek::Signature, ApiError> {
    let bytes = BASE64
        .decode(encoded.trim().as_bytes())
        .map_err(|e| ApiError::internal(format!("The signature is not valid base64: {e}")))?;
    let bytes: [u8; 64] = bytes
        .try_into()
        .map_err(|_| ApiError::internal("An ed25519 signature must be 64 bytes"))?;
    Ok(ed25519_dalek::Signature::from_bytes(&bytes))
}

fn verifying_key(encoded: &str) -> Result<ed25519_dalek::VerifyingKey, ApiError> {
    let bytes = BASE64
        .decode(encoded.trim().as_bytes())
        .map_err(|e| ApiError::internal(format!("`publicKey` is not valid base64: {e}")))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| ApiError::internal("An ed25519 public key must be 32 bytes"))?;
    ed25519_dalek::VerifyingKey::from_bytes(&bytes)
        .map_err(|e| ApiError::internal(format!("`publicKey` is not a valid ed25519 key: {e}")))
}

fn staging_dir(rt: &Runtime) -> Result<PathBuf, ApiError> {
    let dir = std::env::temp_dir().join(format!("vantail-update-{}", rt.config.app.identifier));
    std::fs::create_dir_all(&dir)
        .map_err(|e| ApiError::io("Could not create a staging directory", e))?;
    Ok(dir)
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

fn install(rt: &Runtime) -> ApiResult {
    let pending = rt.updates.take().ok_or_else(|| {
        ApiError::new(
            crate::error::code::NOT_FOUND,
            "No update has been downloaded. Call `updater.download()` first.",
        )
    })?;

    let installed = Installation::locate()?;
    let staging = staging_dir(rt)?.join("unpacked");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|e| ApiError::io("Could not prepare the update", e))?;

    unpack(&pending.archive, &staging)?;
    let replacement = single_entry(&staging)?;

    swap(&installed, &replacement)?;

    let executable = installed.root.join(&installed.executable_within_root);
    std::process::Command::new(&executable)
        .args(std::env::args().skip(1))
        .spawn()
        .map_err(|e| ApiError::io("The update is installed but would not start", e))?;

    // The retired copy is removed on the next start, once nothing is running
    // out of it any more.
    std::process::exit(0);
}

/// Put the new version where the old one was, keeping the old one
/// recoverable until the next start.
///
/// Everywhere but Windows the installation is one directory - a `.app` bundle
/// or a plain folder - and moving it aside in a single rename is both atomic
/// and trivially reversible.
#[cfg(not(windows))]
fn swap(installed: &Installation, replacement: &Path) -> Result<(), ApiError> {
    // Move the old one aside rather than deleting it: if the rename of the
    // new one fails, putting it back is the recovery.
    let retired = installed.root.with_extension("old");
    let _ = std::fs::remove_dir_all(&retired);
    std::fs::rename(&installed.root, &retired)
        .map_err(|e| ApiError::io("Could not move the current version aside", e))?;

    if let Err(error) = std::fs::rename(replacement, &installed.root) {
        let _ = std::fs::rename(&retired, &installed.root);
        return Err(ApiError::io(
            "Could not put the new version in place",
            error,
        ));
    }
    Ok(())
}

/// Windows will not rename a directory that holds a running executable, and
/// the WebView2 data folder sitting beside it is locked besides - so the
/// single rename above fails with `Access is denied` there.
///
/// Renaming the running `.exe` itself *is* permitted (only deleting and
/// overwriting are not), so the application's own files are replaced one at a
/// time and anything else in the directory - user data, logs - is left where
/// it is, which is the right outcome regardless.
#[cfg(windows)]
fn swap(installed: &Installation, replacement: &Path) -> Result<(), ApiError> {
    replace_entries(replacement, &installed.root)
}

/// Move every top-level entry of `from` into `into`, retiring whatever it
/// displaces to a `<name>.old` beside it. Either all of them move or none do.
#[cfg_attr(not(windows), allow(dead_code))]
fn replace_entries(from: &Path, into: &Path) -> Result<(), ApiError> {
    let mut names = std::fs::read_dir(from)
        .map_err(|e| ApiError::io("Could not read the extracted update", e))?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .collect::<Vec<_>>();
    names.sort();

    let mut retired: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut placed: Vec<PathBuf> = Vec::new();

    for name in names {
        let target = into.join(&name);

        if target.exists() {
            let aside = retired_name(&target);
            remove(&aside);
            if let Err(error) = std::fs::rename(&target, &aside) {
                undo(&placed, &retired);
                return Err(ApiError::io(
                    "Could not move the current version aside",
                    error,
                ));
            }
            retired.push((aside, target.clone()));
        }

        if let Err(error) = std::fs::rename(from.join(&name), &target) {
            undo(&placed, &retired);
            return Err(ApiError::io(
                "Could not put the new version in place",
                error,
            ));
        }
        placed.push(target);
    }

    Ok(())
}

/// Take back a part-finished replacement: the new files come out, then the
/// old ones go back to the names they were moved off.
#[cfg_attr(not(windows), allow(dead_code))]
fn undo(placed: &[PathBuf], retired: &[(PathBuf, PathBuf)]) {
    for path in placed {
        remove(path);
    }
    for (aside, original) in retired {
        let _ = std::fs::rename(aside, original);
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn remove(path: &Path) {
    if path.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else {
        let _ = std::fs::remove_file(path);
    }
}

/// `MyApp.exe` -> `MyApp.exe.old`. Appended rather than substituted, so the
/// retired name never collides with a real one and the original is always
/// recoverable by dropping the suffix.
#[cfg_attr(not(windows), allow(dead_code))]
fn retired_name(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".old");
    path.with_file_name(name)
}

fn unpack(archive: &Path, into: &Path) -> Result<(), ApiError> {
    let file = std::fs::File::open(archive)
        .map_err(|e| ApiError::io("Could not open the downloaded update", e))?;
    let decoder = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
    let mut tar = tar::Archive::new(decoder);
    tar.set_preserve_permissions(true);
    tar.set_overwrite(true);

    // `unpack` refuses entries that would escape the destination, which is
    // the property that matters for an archive fetched over the network.
    tar.unpack(into)
        .map_err(|e| ApiError::io("Could not extract the update", e))
}

/// An update archive holds exactly one thing: the new application.
fn single_entry(directory: &Path) -> Result<PathBuf, ApiError> {
    let mut entries = std::fs::read_dir(directory)
        .map_err(|e| ApiError::io("Could not read the extracted update", e))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        // macOS archives routinely carry these; they are not the application.
        .filter(|path| {
            !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("._") || name == ".DS_Store")
        })
        .collect::<Vec<_>>();

    match entries.len() {
        1 => Ok(entries.remove(0)),
        found => Err(ApiError::internal(format!(
            "The update archive should contain exactly one application, but it has {found} entries"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory that removes itself.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("vantail-swap-{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("scratch");
            Self(dir)
        }

        fn file(&self, path: &str, contents: &str) -> PathBuf {
            let full = self.0.join(path);
            std::fs::create_dir_all(full.parent().expect("parent")).expect("parents");
            std::fs::write(&full, contents).expect("write");
            full
        }

        fn read(&self, path: &str) -> String {
            std::fs::read_to_string(self.0.join(path)).expect("read")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn replaces_each_entry_and_retires_what_it_displaced() {
        let scratch = Scratch::new("replace");
        scratch.file("new/app.exe", "1.1.0");
        scratch.file("new/dist/index.html", "new page");
        scratch.file("old/app.exe", "1.0.0");
        scratch.file("old/dist/index.html", "old page");

        replace_entries(&scratch.0.join("new"), &scratch.0.join("old")).expect("swap");

        assert_eq!(scratch.read("old/app.exe"), "1.1.0");
        assert_eq!(scratch.read("old/dist/index.html"), "new page");
        assert_eq!(scratch.read("old/app.exe.old"), "1.0.0");
        assert_eq!(scratch.read("old/dist.old/index.html"), "old page");
    }

    /// The WebView2 data folder, logs, anything the archive does not carry.
    #[test]
    fn leaves_alone_what_the_update_does_not_carry() {
        let scratch = Scratch::new("untouched");
        scratch.file("new/app.exe", "1.1.0");
        scratch.file("old/app.exe", "1.0.0");
        scratch.file("old/app.exe.WebView2/lockfile", "held");

        replace_entries(&scratch.0.join("new"), &scratch.0.join("old")).expect("swap");

        assert_eq!(scratch.read("old/app.exe.WebView2/lockfile"), "held");
    }

    /// The rollback a failed entry triggers, exercised on its own: contriving
    /// a rename failure part-way through differs too much between platforms to
    /// test the two together.
    #[test]
    fn puts_everything_back_when_a_swap_is_abandoned() {
        let scratch = Scratch::new("rollback");
        scratch.file("app/app.exe", "1.1.0");
        scratch.file("app/app.exe.old", "1.0.0");
        scratch.file("app/dist.old/index.html", "old page");

        undo(
            &[scratch.0.join("app/app.exe")],
            &[
                (
                    scratch.0.join("app/app.exe.old"),
                    scratch.0.join("app/app.exe"),
                ),
                (scratch.0.join("app/dist.old"), scratch.0.join("app/dist")),
            ],
        );

        assert_eq!(scratch.read("app/app.exe"), "1.0.0");
        assert_eq!(scratch.read("app/dist/index.html"), "old page");
        assert!(!scratch.0.join("app/app.exe.old").exists());
        assert!(!scratch.0.join("app/dist.old").exists());
    }

    #[test]
    fn reports_an_update_directory_it_cannot_read() {
        let scratch = Scratch::new("unreadable");
        std::fs::create_dir_all(scratch.0.join("into")).expect("dir");

        let error = replace_entries(&scratch.0.join("missing"), &scratch.0.join("into"))
            .expect_err("there is nothing to move");
        assert_eq!(error.code, crate::error::code::NOT_FOUND);
    }

    #[test]
    fn appends_the_retired_suffix_rather_than_replacing_the_extension() {
        assert_eq!(
            retired_name(Path::new("/apps/MyApp.exe")),
            PathBuf::from("/apps/MyApp.exe.old")
        );
    }
}
