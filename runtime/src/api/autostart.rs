//! `autostart.*` - starting with the machine.
//!
//! Each platform has its own register of things to launch at login, and none
//! of them is reachable from a page:
//!
//! - macOS: a launch agent property list in `~/Library/LaunchAgents`.
//! - Windows: a value under `HKCU\...\CurrentVersion\Run`.
//! - Linux: a desktop entry in `~/.config/autostart`.
//!
//! All three name a path, so this only works on an installed application. A
//! `vantail dev` build would register the runtime binary and a config file in
//! a temporary directory, which is worse than useless - so it says no.

use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::Runtime;

pub fn dispatch(rt: &Runtime, method: &str, _params: Value) -> ApiResult {
    rt.permissions.require(rt.permissions.autostart, method)?;

    match method {
        "autostart.enable" => {
            enable(rt)?;
            Ok(Value::Null)
        }
        "autostart.disable" => {
            disable(rt)?;
            Ok(Value::Null)
        }
        "autostart.isEnabled" => Ok(json!(is_enabled(rt))),
        _ => Err(ApiError::unknown_method(method)),
    }
}

/// What login should start.
///
/// The bundle on macOS, the executable everywhere else - launching the inner
/// binary of a `.app` directly gives a process with no icon and no menu bar.
fn target(rt: &Runtime) -> Result<std::path::PathBuf, ApiError> {
    let exe = std::env::current_exe()
        .map_err(|e| ApiError::io("Could not find the running executable", e))?;

    // `vantail package` renames the executable to the application, so a binary
    // still called `vantail-runtime` is one being run directly - out of a
    // build directory, or by `vantail dev`. Registering that path would name
    // a shared runtime and a config file that is not going to outlive the
    // session.
    let unpackaged = rt.is_dev()
        || exe
            .file_stem()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "vantail-runtime");

    if unpackaged {
        return Err(ApiError::unsupported(
            "This is an unpackaged build. Run `vantail package` first - starting \
             at login records a path, and this one will not survive the session.",
        ));
    }

    #[cfg(target_os = "macos")]
    {
        let mut ancestor = exe.as_path();
        while let Some(parent) = ancestor.parent() {
            if parent.extension().is_some_and(|ext| ext == "app") {
                return Ok(parent.to_path_buf());
            }
            ancestor = parent;
        }
    }

    Ok(exe)
}

// ---------------------------------------------------------------------------
// macOS: a launch agent
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn agent_path(rt: &Runtime) -> Result<std::path::PathBuf, ApiError> {
    let home =
        dirs::home_dir().ok_or_else(|| ApiError::internal("This account has no home directory"))?;
    Ok(home
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", rt.config.app.identifier)))
}

#[cfg(target_os = "macos")]
fn enable(rt: &Runtime) -> Result<(), ApiError> {
    let bundle = target(rt)?;
    let path = agent_path(rt)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| ApiError::io("Could not create ~/Library/LaunchAgents", e))?;
    }

    // `open` rather than the executable inside the bundle: launching that
    // directly gives a process with no icon and no menu bar.
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>{bundle}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#,
        label = escape_xml(&rt.config.app.identifier),
        bundle = escape_xml(&bundle.to_string_lossy()),
    );

    std::fs::write(&path, plist).map_err(|e| ApiError::io("Could not write the launch agent", e))
}

#[cfg(target_os = "macos")]
fn disable(rt: &Runtime) -> Result<(), ApiError> {
    let path = agent_path(rt)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        // Already off is the state that was asked for.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ApiError::io("Could not remove the launch agent", error)),
    }
}

#[cfg(target_os = "macos")]
fn is_enabled(rt: &Runtime) -> bool {
    agent_path(rt).is_ok_and(|path| path.exists())
}

/// The identifier and the path both land inside XML elements. Only the
/// property list needs this; a desktop entry is not XML.
#[cfg(target_os = "macos")]
fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

// ---------------------------------------------------------------------------
// Linux: a desktop entry
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn entry_path(rt: &Runtime) -> Result<std::path::PathBuf, ApiError> {
    let config = dirs::config_dir()
        .ok_or_else(|| ApiError::internal("This account has no config directory"))?;
    Ok(config
        .join("autostart")
        .join(format!("{}.desktop", rt.config.app.identifier)))
}

#[cfg(target_os = "linux")]
fn enable(rt: &Runtime) -> Result<(), ApiError> {
    let exe = target(rt)?;
    let path = entry_path(rt)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| ApiError::io("Could not create the autostart directory", e))?;
    }

    // A desktop entry is line-based with no quoting, so a newline in a value
    // would forge a key. Neither of these should contain one; refuse if it does.
    for value in [rt.config.app.name.as_str(), &exe.to_string_lossy()] {
        if value.contains('\n') {
            return Err(ApiError::invalid_params(
                "A newline in the application name or path cannot go in a desktop entry",
            ));
        }
    }

    let entry = format!(
        "[Desktop Entry]\nType=Application\nName={name}\nExec={exec}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        name = rt.config.app.name,
        exec = exe.to_string_lossy(),
    );

    std::fs::write(&path, entry).map_err(|e| ApiError::io("Could not write the autostart entry", e))
}

#[cfg(target_os = "linux")]
fn disable(rt: &Runtime) -> Result<(), ApiError> {
    let path = entry_path(rt)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ApiError::io("Could not remove the autostart entry", error)),
    }
}

#[cfg(target_os = "linux")]
fn is_enabled(rt: &Runtime) -> bool {
    entry_path(rt).is_ok_and(|path| path.exists())
}

// ---------------------------------------------------------------------------
// Windows: a value under the Run key
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn enable(rt: &Runtime) -> Result<(), ApiError> {
    let exe = target(rt)?;
    // Quoted: a path with a space is otherwise read as a command and arguments.
    let command = format!("\"{}\"", exe.to_string_lossy());
    windows_run_key::set(&rt.config.app.identifier, Some(&command))
}

#[cfg(target_os = "windows")]
fn disable(rt: &Runtime) -> Result<(), ApiError> {
    windows_run_key::set(&rt.config.app.identifier, None)
}

#[cfg(target_os = "windows")]
fn is_enabled(rt: &Runtime) -> bool {
    windows_run_key::get(&rt.config.app.identifier).is_some()
}

/// The registry, through `reg.exe`.
///
/// A registry crate for three calls is a dependency for the sake of one, and
/// `reg.exe` ships with every Windows since 2000.
#[cfg(target_os = "windows")]
mod windows_run_key {
    use super::ApiError;

    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

    pub fn set(name: &str, command: Option<&str>) -> Result<(), ApiError> {
        let output = match command {
            Some(command) => std::process::Command::new("reg")
                .args(["add", KEY, "/v", name, "/t", "REG_SZ", "/d", command, "/f"])
                .output(),
            None => std::process::Command::new("reg")
                .args(["delete", KEY, "/v", name, "/f"])
                .output(),
        }
        .map_err(|e| ApiError::io("Could not run reg.exe", e))?;

        // Deleting something that is not there is the state that was asked for.
        if output.status.success() || (command.is_none() && get(name).is_none()) {
            return Ok(());
        }

        Err(ApiError::internal(format!(
            "The registry refused the change: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }

    pub fn get(name: &str) -> Option<String> {
        let output = std::process::Command::new("reg")
            .args(["query", KEY, "/v", name])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        // `    name    REG_SZ    "C:\path\app.exe"`
        let line = text.lines().find(|line| line.contains("REG_SZ"))?;
        Some(line.split("REG_SZ").nth(1)?.trim().to_string())
    }
}
