//! `vantail.json` - the only thing the runtime knows about an application.
//!
//! The CLI compiles the developer's `vantail.config.ts` down to this file and
//! hands it to the runtime with `--config`. The runtime never reads
//! TypeScript, never reads `package.json`, and never runs a bundler.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::chrome::menu::MenuSpec;
use crate::chrome::TraySpec;
use crate::permissions::PermissionsConfig;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub app: AppConfig,
    #[serde(default)]
    pub window: WindowConfig,
    #[serde(default)]
    pub permissions: PermissionsConfig,
    /// The application menu, installed at startup.
    #[serde(default)]
    pub menu: Option<Vec<MenuSpec>>,
    /// The tray icon, created at startup.
    #[serde(default)]
    pub tray: Option<TraySpec>,
    /// Present only in `vantail dev`; when set the webview loads this URL
    /// instead of the `vantail://` custom protocol.
    #[serde(default)]
    pub dev: Option<DevConfig>,
    /// Directory holding the built web assets, relative to the config file.
    #[serde(default = "default_dist_dir")]
    pub dist_dir: String,
    /// Enable the webview inspector. Defaults to on in dev, off otherwise.
    #[serde(default)]
    pub devtools: Option<bool>,
    /// Where to look for new versions, and the key that signs them.
    #[serde(default)]
    pub updater: Option<UpdaterConfig>,
    /// Custom URL schemes this application answers to, e.g. `["myapp"]`.
    #[serde(default)]
    pub protocols: Vec<String>,
    /// Refuse to start twice, handing the second launch to the first.
    ///
    /// Defaults to on when `protocols` is set, because that is how a deep
    /// link reaches a running application on Windows and Linux.
    #[serde(default)]
    pub single_instance: Option<bool>,
    /// Quit once every window is closed. Turn this off for apps that live in
    /// the tray and have no window most of the time.
    #[serde(default = "yes")]
    pub quit_on_last_window_closed: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub name: String,
    pub identifier: String,
    #[serde(default = "default_version")]
    pub version: String,
    /// A PNG for the window and taskbar, resolved by the CLI.
    ///
    /// macOS takes its icon from the bundle instead, so this is only used on
    /// Windows and Linux.
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowConfig {
    pub title: Option<String>,
    #[serde(default = "default_width")]
    pub width: f64,
    #[serde(default = "default_height")]
    pub height: f64,
    pub min_width: Option<f64>,
    pub min_height: Option<f64>,
    pub max_width: Option<f64>,
    pub max_height: Option<f64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    #[serde(default = "yes")]
    pub resizable: bool,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default)]
    pub fullscreen: bool,
    #[serde(default = "yes")]
    pub decorations: bool,
    /// Whether the title bar is a bar, or space the application draws in.
    #[serde(default)]
    pub title_bar_style: TitleBarStyle,
    /// Where to put the traffic lights when the title bar is hidden. macOS
    /// only; ignored everywhere else.
    ///
    /// Rarely needed: `title_bar_height` already centres them.
    #[serde(default)]
    pub traffic_light_position: Option<Inset>,
    /// Whether the platform draws the window buttons, or the application does.
    ///
    /// macOS keeps its traffic lights when the title bar is hidden, and they
    /// are a fixed size. `hidden` takes them away so an application can draw
    /// its own - bigger, or in its own style - the way it already has to on
    /// the platforms that keep nothing.
    #[serde(default)]
    pub title_bar_buttons: TitleBarButtons,
    /// How tall the bar the application draws should be.
    ///
    /// Defaults to the height of the platform's own, which is what makes a
    /// custom bar look like a title bar rather than like a div. Set it larger
    /// for a browser-style toolbar - the traffic lights are re-centred in it,
    /// which is the part that is easy to get wrong by hand.
    #[serde(default)]
    pub title_bar_height: Option<f64>,
    #[serde(default)]
    pub transparent: bool,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default = "yes")]
    pub center: bool,
    #[serde(default = "yes")]
    pub visible: bool,
    /// What the window's own close button does.
    #[serde(default)]
    pub close_behavior: CloseBehavior,
}

/// Whether the window has a title bar, or the application draws over it.
///
/// `Hidden` is the arrangement every editor and browser uses: no bar, the web
/// content running all the way to the top edge, and a toolbar of the
/// application's own where the bar would have been.
///
/// On macOS the traffic lights stay - they are the system's, and an
/// application that drew its own would get them subtly wrong. Windows and
/// Linux have no way to keep the buttons without the bar, so `Hidden` there
/// is an undecorated window and the application draws its own controls.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TitleBarStyle {
    #[default]
    Default,
    Hidden,
}

/// Who draws close, minimise and zoom.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TitleBarButtons {
    /// The platform's own, where it has any. macOS does; nowhere else does
    /// once the title bar is hidden.
    #[default]
    System,
    /// None: the application draws them, and `insetLeft` is zero so it knows
    /// to.
    Hidden,
}

/// A position in logical pixels, for nudging the traffic lights.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inset {
    pub x: f64,
    pub y: f64,
}

/// An application that lives in the tray has to survive its window closing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseBehavior {
    /// Destroy the window. With no other windows open and
    /// `quitOnLastWindowClosed`, that ends the application.
    #[default]
    Close,
    /// Hide it instead. The webview keeps running, so timers keep firing and
    /// sockets stay connected - which is the whole point for a background app.
    Hide,
    /// Do nothing, and let the application decide from `window.closeRequested`.
    Ask,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdaterConfig {
    /// URL of the update manifest. `{{target}}`, `{{arch}}` and
    /// `{{currentVersion}}` are substituted before the request.
    pub endpoint: String,
    /// base64 ed25519 public key. Its private half signs release archives;
    /// an update that does not verify against it is refused.
    pub public_key: String,
    #[serde(default = "default_update_timeout")]
    pub timeout_ms: u64,
}

fn default_update_timeout() -> u64 {
    30_000
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevConfig {
    pub url: String,
}

impl Default for WindowConfig {
    fn default() -> Self {
        serde_json::from_str("{}").expect("WindowConfig defaults are total")
    }
}

fn yes() -> bool {
    true
}
fn default_width() -> f64 {
    1000.0
}
fn default_height() -> f64 {
    700.0
}
fn default_version() -> String {
    "0.0.0".into()
}
fn default_dist_dir() -> String {
    "dist".into()
}

/// A parsed config plus the asset directory derived from where it was found.
#[derive(Debug, Clone)]
pub struct LoadedConfig {
    pub config: Config,
    pub dist_dir: PathBuf,
}

impl Config {
    /// Whether this application should refuse to run twice.
    pub fn wants_single_instance(&self) -> bool {
        self.single_instance.unwrap_or(!self.protocols.is_empty())
    }
}

impl LoadedConfig {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
        let config: Config = serde_json::from_str(&text)
            .map_err(|e| format!("Invalid config at {}: {e}", path.display()))?;

        // Asset paths in the config are relative to the config file, so a
        // project works the same whatever directory it is launched from.
        let config_dir = path
            .canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));

        Ok(Self {
            dist_dir: config_dir.join(&config.dist_dir),
            config,
        })
    }

    /// Where the runtime looks when `--config` is not given: next to the
    /// executable (portable layout), then `../Resources` (macOS `.app`), then
    /// the current directory (running from a project root).
    pub fn discover() -> Option<PathBuf> {
        let mut candidates: Vec<PathBuf> = Vec::new();

        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("vantail.json"));
                candidates.push(dir.join("resources").join("vantail.json"));
                if let Some(contents) = dir.parent() {
                    candidates.push(contents.join("Resources").join("vantail.json"));
                }
            }
        }
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("vantail.json"));
        }

        candidates.into_iter().find(|p| p.is_file())
    }
}
