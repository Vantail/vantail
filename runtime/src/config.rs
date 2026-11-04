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
    /// Show in the Dock and the Cmd-Tab switcher. macOS only.
    ///
    /// Off is the accessory activation policy, which is what a menu bar
    /// application wants: it lives in the tray, and a Dock icon would be a
    /// second way in that leads nowhere.
    #[serde(default = "yes")]
    pub show_in_dock: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

/// `#rgb` or `#rrggbb` as the channels wry wants, opaque.
///
/// Anything else is `None`, and the platform's own background stays - a bad
/// colour string should not be the reason a window fails to open.
pub fn parse_color(value: &str) -> Option<(u8, u8, u8, u8)> {
    let hex = value.trim().strip_prefix('#')?;
    let digits = hex_digits(hex)?;

    match *digits.as_slice() {
        // `#abc` means `#aabbcc`, so each digit is doubled.
        [red, green, blue] => Some((red * 17, green * 17, blue * 17, 255)),
        [red_high, red_low, green_high, green_low, blue_high, blue_low] => Some((
            red_high * 16 + red_low,
            green_high * 16 + green_low,
            blue_high * 16 + blue_low,
            255,
        )),
        _ => None,
    }
}

/// The value of each hex digit in `text`, or `None` if any character is not one.
fn hex_digits(text: &str) -> Option<Vec<u8>> {
    let mut digits = Vec::with_capacity(text.len());
    for character in text.chars() {
        let digit = character.to_digit(16)?;
        digits.push(digit as u8);
    }
    Some(digits)
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
    /// What shows through before the page has painted, as `#rgb` or `#rrggbb`.
    ///
    /// Worth setting. A web view paints on its own schedule, and during a live
    /// resize it is a frame or two behind the window - so growing a window
    /// quickly leaves a strip down the right that the page has not reached
    /// yet. Whatever is under it shows, and by default that is a neutral grey
    /// that looks like a hole. Matched to the application's own background it
    /// is invisible instead.
    ///
    /// It does not make the page paint any sooner; nothing here can. It stops
    /// the gap being conspicuous while it lasts.
    pub background_color: Option<String>,
    /// Whether the title bar is a bar, or space the application draws in.
    #[serde(default)]
    pub title_bar_style: TitleBarStyle,
    /// Where to put the traffic lights when the title bar is hidden. macOS
    /// only; ignored everywhere else.
    ///
    /// Rarely needed: `title_bar_height` already centres them.
    #[serde(default)]
    pub traffic_light_position: Option<Inset>,

    /// Let the page scroll as a document. Off by default.
    ///
    /// An application window is a fixed frame: it does not move when the
    /// wheel turns, it does not rubber-band at the edges, and it has no
    /// scrollbars. What scrolls is the panes inside it, which say so
    /// themselves with `overflow`.
    ///
    /// Turn this on for a window that really is a page - a long document, a
    /// report - and it behaves as a browser would.
    #[serde(default)]
    pub scroll: bool,

    /// Animate maximise and restore. macOS only.
    ///
    /// AppKit's zoom animation runs for about 200ms, and the web view lays
    /// out asynchronously in another process - so the page stays drawn at its
    /// old size for the length of it. Off, the window snaps to the new frame
    /// and the page is right in the next frame.
    #[serde(default)]
    pub animate_zoom: bool,

    /// Round the window's corners, in logical pixels.
    ///
    /// Only honoured for a window with no decorations: a framed one already
    /// has the platform's corners, and rounding the content inside them
    /// leaves a notch where the two shapes disagree.
    #[serde(default)]
    pub border_radius: Option<BorderRadius>,
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

/// How much of a window's corners to round.
///
/// A number rounds all four; naming corners gives each its own radius and
/// leaves the rest square.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(untagged)]
pub enum BorderRadius {
    All(f64),
    Corners(Corners),
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Corners {
    pub top_left: Option<f64>,
    pub top_right: Option<f64>,
    pub bottom_left: Option<f64>,
    pub bottom_right: Option<f64>,
}

/// The four radii, in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Radii {
    pub top_left: f64,
    pub top_right: f64,
    pub bottom_left: f64,
    pub bottom_right: f64,
}

impl Radii {
    /// Whether one `cornerRadius` can draw this, or it needs a shape.
    pub fn uniform(self) -> Option<f64> {
        let same = self.top_left == self.top_right
            && self.top_left == self.bottom_left
            && self.top_left == self.bottom_right;
        if same {
            Some(self.top_left)
        } else {
            None
        }
    }
}

impl BorderRadius {
    /// The four radii, or `None` when nothing would be rounded.
    pub fn radii(self) -> Option<Radii> {
        let radii = match self {
            Self::All(radius) => Radii {
                top_left: radius,
                top_right: radius,
                bottom_left: radius,
                bottom_right: radius,
            },
            Self::Corners(corners) => Radii {
                top_left: radius_or_square(corners.top_left),
                top_right: radius_or_square(corners.top_right),
                bottom_left: radius_or_square(corners.bottom_left),
                bottom_right: radius_or_square(corners.bottom_right),
            },
        };

        let rounded = radii.top_left > 0.0
            || radii.top_right > 0.0
            || radii.bottom_left > 0.0
            || radii.bottom_right > 0.0;

        if rounded {
            Some(radii)
        } else {
            None
        }
    }
}

/// A corner the config does not name stays square.
fn radius_or_square(radius: Option<f64>) -> f64 {
    match radius {
        Some(radius) => radius,
        None => 0.0,
    }
}

/// A position in logical pixels, for nudging the traffic lights.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Inset {
    pub x: f64,
    /// How far down, or `None` to leave them centred in the bar.
    ///
    /// Optional because nudging the group sideways is the common wish, and
    /// having to restate the vertical centre to do it means restating it again
    /// every time the bar's height changes.
    pub y: Option<f64>,
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
    // Every field has a serde default, so an empty object always parses: the
    // defaults live in one place, the serde attributes, rather than also in a
    // hand-written copy here that could drift from them. Anything that breaks
    // this fails the first test that opens a window.
    #[allow(clippy::expect_used)]
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
        match self.single_instance {
            Some(single) => single,
            None => !self.protocols.is_empty(),
        }
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
        let canonical = match path.canonicalize() {
            Ok(canonical) => canonical,
            Err(_) => path.to_path_buf(),
        };
        let config_dir = match canonical.parent() {
            Some(parent) => parent.to_path_buf(),
            None => PathBuf::from("."),
        };

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
            candidates.extend(beside_executable(&exe));
        }
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("vantail.json"));
        }

        for candidate in candidates {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }
}

/// The places a config can sit relative to the executable: next to it, in a
/// `resources` folder beside it, and in a macOS bundle's `Resources`.
fn beside_executable(exe: &Path) -> Vec<PathBuf> {
    let Some(dir) = exe.parent() else {
        return Vec::new();
    };
    let mut candidates = vec![
        dir.join("vantail.json"),
        dir.join("resources").join("vantail.json"),
    ];
    if let Some(contents) = dir.parent() {
        candidates.push(contents.join("Resources").join("vantail.json"));
    }
    candidates
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_misspelt_key_is_refused_wherever_it_is() {
        // The schema the CLI checks with refuses all of these, and the
        // runtime used to read straight past them - a setting someone wrote
        // that silently did nothing. `scripts/test/config-contract.test.js`
        // tries every object against both; these are the ones that slipped.
        let app = serde_json::json!({ "name": "A", "identifier": "dev.test.a" });
        for (section, value) in [
            (
                "app",
                serde_json::json!({ "name": "A", "identifier": "dev.test.a", "verison": "1" }),
            ),
            (
                "window",
                serde_json::json!({ "borderRadius": { "topLeft": 4, "topLft": 4 } }),
            ),
            (
                "window",
                serde_json::json!({ "trafficLightPosition": { "x": 1, "z": 2 } }),
            ),
            (
                "permissions",
                serde_json::json!({ "filesystem": { "read": { "alow": [] } } }),
            ),
            (
                "permissions",
                serde_json::json!({ "clipboard": { "raed": true } }),
            ),
            (
                "permissions",
                serde_json::json!({ "database": { "encrypted": true } }),
            ),
            (
                "permissions",
                serde_json::json!({ "shell": { "allow": [
                { "program": "git", "args": [{ "patern": "x" }] }
            ] } }),
            ),
            (
                "menu",
                serde_json::json!([{ "type": "normal", "id": "a", "label": "A", "acelerator": "Ctrl+A" }]),
            ),
            (
                "menu",
                serde_json::json!([{ "type": "separator", "label": "x" }]),
            ),
        ] {
            let mut config = serde_json::json!({ "app": app });
            if section == "app" {
                config["app"] = value.clone();
            } else {
                config[section] = value.clone();
            }
            assert!(
                serde_json::from_value::<Config>(config).is_err(),
                "{section}: {value} was accepted"
            );
        }
    }

    #[test]
    fn an_app_is_in_the_dock_unless_it_says_otherwise() {
        // The CLI leaves `showInDock` out entirely when nobody set it, so the
        // default has to live here rather than there.
        let config: Config = serde_json::from_value(serde_json::json!({
            "app": { "name": "A", "identifier": "dev.test.a" },
            "window": {},
        }))
        .expect("a minimal config should load");
        assert!(config.show_in_dock);
        assert!(config.quit_on_last_window_closed);
    }

    #[test]
    fn naming_corners_gives_each_its_own_radius() {
        let all = BorderRadius::All(10.0).radii().expect("a radius rounds");
        assert_eq!(all.uniform(), Some(10.0), "one value on all four corners");

        // A radius of zero rounds nothing, rather than rounding by zero.
        assert!(BorderRadius::All(0.0).radii().is_none());
        assert!(
            BorderRadius::Corners(Corners::default()).radii().is_none(),
            "no corner named is no rounding"
        );

        let top = BorderRadius::Corners(Corners {
            top_left: Some(8.0),
            top_right: Some(8.0),
            ..Corners::default()
        })
        .radii()
        .expect("naming two corners rounds");
        assert_eq!(top.top_left, 8.0);
        assert_eq!(top.top_right, 8.0);
        assert_eq!(top.bottom_left, 0.0, "anything left out is square");
        assert_eq!(top.bottom_right, 0.0);
        assert_eq!(
            top.uniform(),
            None,
            "square corners need a shape, not a radius"
        );

        let mixed = BorderRadius::Corners(Corners {
            top_left: Some(20.0),
            top_right: Some(4.0),
            bottom_left: Some(12.0),
            bottom_right: Some(0.0),
        })
        .radii()
        .expect("four different radii round");
        assert_eq!(mixed.top_left, 20.0);
        assert_eq!(mixed.top_right, 4.0);
        assert_eq!(mixed.bottom_left, 12.0);
        assert_eq!(mixed.uniform(), None);
    }

    #[test]
    fn a_window_has_the_platforms_corners_unless_it_names_a_radius() {
        let config: Config = serde_json::from_value(serde_json::json!({
            "app": { "name": "A", "identifier": "dev.test.a" },
            "window": {},
        }))
        .expect("a minimal config should load");
        assert!(config.window.border_radius.is_none());

        let config: Config = serde_json::from_value(serde_json::json!({
            "app": { "name": "A", "identifier": "dev.test.a" },
            "window": { "decorations": false, "borderRadius": 12 },
        }))
        .expect("a window naming a radius should load");
        let radius = config.window.border_radius.expect("a radius");
        let radii = radius.radii().expect("a radius of 12 rounds something");
        assert_eq!(radii.uniform(), Some(12.0));
    }

    #[test]
    fn zooming_snaps_unless_a_window_asks_for_the_animation() {
        let config: Config = serde_json::from_value(serde_json::json!({
            "app": { "name": "A", "identifier": "dev.test.a" },
            "window": {},
        }))
        .expect("a minimal config should load");
        assert!(!config.window.animate_zoom);

        let config: Config = serde_json::from_value(serde_json::json!({
            "app": { "name": "A", "identifier": "dev.test.a" },
            "window": { "animateZoom": true },
        }))
        .expect("a window asking for the animation should load");
        assert!(config.window.animate_zoom);
    }

    #[test]
    fn a_window_is_a_fixed_frame_unless_it_asks_to_scroll() {
        let config: Config = serde_json::from_value(serde_json::json!({
            "app": { "name": "A", "identifier": "dev.test.a" },
            "window": {},
        }))
        .expect("a minimal config should load");
        assert!(!config.window.scroll);

        let config: Config = serde_json::from_value(serde_json::json!({
            "app": { "name": "A", "identifier": "dev.test.a" },
            "window": { "scroll": true },
        }))
        .expect("a window asking to scroll should load");
        assert!(config.window.scroll);
    }

    #[test]
    fn a_menu_bar_app_can_turn_the_dock_icon_off() {
        let config: Config = serde_json::from_value(serde_json::json!({
            "app": { "name": "A", "identifier": "dev.test.a" },
            "window": {},
            "showInDock": false,
            "quitOnLastWindowClosed": false,
        }))
        .expect("config with showInDock should load");
        assert!(!config.show_in_dock);
        assert!(!config.quit_on_last_window_closed);
    }

    use super::*;

    #[test]
    fn a_colour_with_a_multibyte_character_is_refused_rather_than_split() {
        // Six bytes, but `é` takes two of them: cutting the text into pairs of
        // bytes would split it, which used to panic.
        assert_eq!(parse_color("#aébcd"), None);
        assert_eq!(parse_color("#+f+f+f"), None);
    }

    #[test]
    fn a_colour_is_read_in_either_length() {
        assert_eq!(parse_color("#1b1e25"), Some((0x1b, 0x1e, 0x25, 255)));
        // `#abc` is `#aabbcc`, which is the shorthand CSS has taught everyone.
        assert_eq!(parse_color("#abc"), Some((0xaa, 0xbb, 0xcc, 255)));
        assert_eq!(parse_color("  #FFF  "), Some((255, 255, 255, 255)));
    }

    #[test]
    fn nonsense_leaves_the_platform_s_own_background() {
        // A window that would not open because of a typo in a colour is a
        // worse outcome than a window that opens the ordinary colour.
        for bad in ["", "#", "1b1e25", "#12", "#12345", "#gggggg", "red"] {
            assert_eq!(parse_color(bad), None, "{bad:?} should not parse");
        }
    }
}
