//! The parts of an application that live outside its windows: the menu bar
//! and the tray icon.
//!
//! Both are owned by the event loop, because both must be created and
//! modified on the main thread, and both disappear the moment their handle is
//! dropped.

pub mod icon;
pub mod menu;
pub mod titlebar;

use std::collections::HashMap;
use std::path::PathBuf;

use muda::Menu;
use serde::Deserialize;
use tray_icon::{TrayIcon, TrayIconBuilder};

use crate::error::ApiError;
use crate::state::Runtime;
use menu::{ItemHandle, MenuSpec};

/// The tray icon, as described by config or by `tray.set`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraySpec {
    /// PNG path. Relative paths resolve inside the application's resources.
    pub icon: Option<String>,
    pub tooltip: Option<String>,
    /// Text shown next to the icon. macOS only.
    // Read only from the macOS branch below, which is not dead code so much
    // as code the other platforms have no use for.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub title: Option<String>,
    /// Render the icon as a monochrome template, which is what macOS wants so
    /// the icon inverts correctly in dark menu bars.
    #[serde(default)]
    pub icon_as_template: bool,
    pub menu: Option<Vec<MenuSpec>>,
    /// What a left click on the icon does. A right click always opens the menu.
    #[serde(default)]
    pub left_click: TrayLeftClick,
    /// Which window `showWindow` brings back. The main one by default.
    pub window: Option<String>,
}

/// What clicking the tray icon with the left button does.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrayLeftClick {
    /// Bring the window back if it is hidden, focus it if it is behind
    /// something, and open the menu if it is already in front. Which is what
    /// a tray icon is usually for: getting the window back.
    #[default]
    ShowWindow,
    /// Always open the menu, which is the older macOS convention.
    Menu,
    /// Do nothing but emit `tray.click`, leaving the decision to the app.
    Event,
}

/// What the runtime should do about a left click on the tray icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayActivation {
    /// The window is hidden: bring it back and put it in front.
    ShowAndFocus,
    /// The window is open but behind something.
    Focus,
    /// Nothing useful left to do with a window, so offer the menu.
    ShowMenu,
    /// The click is the application's business, or the library already
    /// handled it.
    Nothing,
}

/// How the tray's target window looked when it was clicked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowState {
    pub visible: bool,
    pub focused: bool,
}

/// Decide what a left click means.
///
/// A pure function, because this is the interesting part and the alternative
/// is testing it by asking someone to click a menu bar - synthetic events do
/// not reach an `NSStatusItem`.
/// The IPC event a `tray_icon` event should become, if any.
///
/// One physical click arrives **twice**: `tray_icon` emits `Click` from both
/// `mouseDown` and `mouseUp`, identical but for `button_state`. Forwarding
/// both gave every listener two `tray.click` events per click - invisible to a
/// handler that shows a window, and fatal to one that toggles, which opened
/// the window on the press and shut it again on the release.
///
/// The release is the click. Enter, Move and Leave fire constantly and nobody
/// has asked for them.
pub fn tray_message(event: &tray_icon::TrayIconEvent) -> Option<(&'static str, serde_json::Value)> {
    match event {
        tray_icon::TrayIconEvent::Click {
            position,
            button,
            button_state,
            ..
        } => {
            if *button_state != tray_icon::MouseButtonState::Up {
                return None;
            }
            Some((
                "tray.click",
                serde_json::json!({
                    "button": format!("{button:?}").to_lowercase(),
                    "x": position.x,
                    "y": position.y,
                }),
            ))
        }
        tray_icon::TrayIconEvent::DoubleClick {
            position, button, ..
        } => Some((
            "tray.doubleClick",
            serde_json::json!({
                "button": format!("{button:?}").to_lowercase(),
                "x": position.x,
                "y": position.y,
            }),
        )),
        _ => None,
    }
}

pub fn tray_activation(mode: TrayLeftClick, window: Option<WindowState>) -> TrayActivation {
    match mode {
        // The library opens the menu itself; there is no event to act on.
        TrayLeftClick::Menu => TrayActivation::Nothing,
        TrayLeftClick::Event => TrayActivation::Nothing,
        TrayLeftClick::ShowWindow => match window {
            // A tray icon is mostly there to get the window back, so that is
            // tried first - and only when the window is already in front,
            // where showing it would change nothing visible, does the menu
            // open instead.
            Some(state) if !state.visible => TrayActivation::ShowAndFocus,
            Some(state) if !state.focused => TrayActivation::Focus,
            Some(_) => TrayActivation::ShowMenu,
            // No such window to bring back.
            None => TrayActivation::ShowMenu,
        },
    }
}

#[derive(Default)]
pub struct Chrome {
    /// What a left click on the tray icon should do.
    left_click: TrayLeftClick,
    /// The window a left click brings back.
    tray_window: Option<String>,
    /// Held because dropping a `Menu` removes it from the application.
    app_menu: Option<Menu>,
    tray: Option<TrayIcon>,
    tray_menu: Option<Menu>,
    /// Every addressable item, from either menu.
    items: HashMap<String, ItemHandle>,
    app_menu_ids: Vec<String>,
    tray_menu_ids: Vec<String>,
    /// Created on first use: constructing it claims resources from the window
    /// server, and an application that never asks for a shortcut should not
    /// pay for one.
    hotkeys: Option<global_hotkey::GlobalHotKeyManager>,
    /// Accelerator -> what was registered for it.
    shortcuts: HashMap<String, Shortcut>,
}

/// One live global shortcut.
pub struct Shortcut {
    /// What `shortcut.pressed` reports.
    pub id: String,
    hotkey: global_hotkey::hotkey::HotKey,
}

impl Chrome {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn item(&self, id: &str) -> Option<&ItemHandle> {
        self.items.get(id)
    }

    // -----------------------------------------------------------------------
    // Global shortcuts
    // -----------------------------------------------------------------------

    pub fn register_shortcut(&mut self, accelerator: &str, id: &str) -> Result<(), ApiError> {
        let hotkey: global_hotkey::hotkey::HotKey = accelerator.parse().map_err(|e| {
            ApiError::invalid_params(format!("`{accelerator}` is not a key combination: {e}"))
        })?;

        if self.shortcuts.contains_key(accelerator) {
            return Err(ApiError::new(
                crate::error::code::ALREADY_EXISTS,
                format!("`{accelerator}` is already registered by this application"),
            ));
        }

        let manager = match self.hotkeys.as_ref() {
            Some(manager) => manager,
            None => {
                let manager = global_hotkey::GlobalHotKeyManager::new().map_err(|e| {
                    ApiError::internal(format!("Could not start listening for shortcuts: {e}"))
                })?;
                self.hotkeys.insert(manager)
            }
        };

        // Registration fails for two quite different reasons, and telling an
        // application they are the same wastes its time. A combination
        // somebody else owns is an ordinary answer. A key this machine does
        // not have - F19 on a keyboard that stops at F12 - is bad input, and
        // no amount of retrying will help.
        manager.register(hotkey).map_err(|error| match error {
            global_hotkey::Error::AlreadyRegistered(_) => ApiError::new(
                crate::error::code::ALREADY_EXISTS,
                format!("`{accelerator}` is already registered, here or by another application"),
            ),
            global_hotkey::Error::UnrecognizedHotKeyCode(_)
            | global_hotkey::Error::HotKeyParseError(_) => ApiError::invalid_params(format!(
                "`{accelerator}` is not a key combination: {error}"
            )),
            other if other.to_string().contains("Unable to find keycode") => {
                ApiError::invalid_params(format!(
                    "`{accelerator}` names a key this system's keyboard layout does not have: {other}"
                ))
            }
            other => ApiError::new(
                crate::error::code::ALREADY_EXISTS,
                format!("`{accelerator}` could not be registered - another application may already use it: {other}"),
            ),
        })?;

        self.shortcuts.insert(
            accelerator.to_string(),
            Shortcut {
                id: id.to_string(),
                hotkey,
            },
        );
        Ok(())
    }

    pub fn unregister_shortcut(&mut self, accelerator: &str) -> Result<(), ApiError> {
        let Some(shortcut) = self.shortcuts.remove(accelerator) else {
            return Err(ApiError::new(
                crate::error::code::NOT_FOUND,
                format!("`{accelerator}` is not registered"),
            ));
        };

        if let Some(manager) = self.hotkeys.as_ref() {
            manager.unregister(shortcut.hotkey).map_err(|e| {
                ApiError::internal(format!("Could not release `{accelerator}`: {e}"))
            })?;
        }
        Ok(())
    }

    pub fn unregister_all_shortcuts(&mut self) -> Result<(), ApiError> {
        let taken = std::mem::take(&mut self.shortcuts);
        let Some(manager) = self.hotkeys.as_ref() else {
            return Ok(());
        };

        let hotkeys: Vec<_> = taken.values().map(|shortcut| shortcut.hotkey).collect();
        manager
            .unregister_all(&hotkeys)
            .map_err(|e| ApiError::internal(format!("Could not release the shortcuts: {e}")))
    }

    pub fn shortcut_registered(&self, accelerator: &str) -> bool {
        self.shortcuts.contains_key(accelerator)
    }

    /// Every live shortcut, as `{ id, accelerator }`.
    pub fn shortcuts(&self) -> Vec<serde_json::Value> {
        let mut listed: Vec<_> = self
            .shortcuts
            .iter()
            .map(|(accelerator, shortcut)| {
                serde_json::json!({ "id": shortcut.id, "accelerator": accelerator })
            })
            .collect();
        // A map has no order, and a list that reshuffles between calls is
        // tiresome to assert on.
        listed.sort_by(|a, b| a["accelerator"].as_str().cmp(&b["accelerator"].as_str()));
        listed
    }

    /// What to report when the window server says a combination was pressed.
    pub fn shortcut_by_hotkey(&self, id: u32) -> Option<(&str, &str)> {
        self.shortcuts
            .iter()
            .find(|(_, shortcut)| shortcut.hotkey.id() == id)
            .map(|(accelerator, shortcut)| (shortcut.id.as_str(), accelerator.as_str()))
    }

    pub fn has_tray(&self) -> bool {
        self.tray.is_some()
    }

    /// Replace the application menu.
    /// Returns the items that had to be left out, if any - see `menu::build`.
    pub fn set_app_menu(&mut self, specs: &[MenuSpec]) -> Result<Vec<String>, ApiError> {
        let mut items = HashMap::new();
        let menu::Built { menu, skipped } =
            menu::build(specs, &mut items).map_err(ApiError::invalid_params)?;

        self.forget(Scope::App);
        self.app_menu_ids = items.keys().cloned().collect();
        self.items.extend(items);

        #[cfg(target_os = "macos")]
        menu.init_for_nsapp();

        self.app_menu = Some(menu);
        Ok(skipped)
    }

    /// Windows hangs the menu off each window rather than the application, so
    /// a window created after the menu was set has to be told about it.
    #[allow(unused_variables)]
    pub fn attach(&self, window: &tao::window::Window) {
        #[cfg(target_os = "windows")]
        {
            use tao::platform::windows::WindowExtWindows;
            if let Some(menu) = &self.app_menu {
                // Safety: the handle comes from the window we were handed,
                // and is valid for as long as this call.
                unsafe {
                    let _ = menu.init_for_hwnd(window.hwnd() as isize);
                }
            }
        }
    }

    pub fn remove_app_menu(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some(menu) = &self.app_menu {
            menu.remove_for_nsapp();
        }
        self.app_menu = None;
        self.forget(Scope::App);
    }

    /// Create or replace the tray icon.
    pub fn set_tray(&mut self, rt: &Runtime, spec: &TraySpec) -> Result<Vec<String>, ApiError> {
        let mut skipped = Vec::new();
        let menu = match &spec.menu {
            Some(specs) => {
                let mut items = HashMap::new();
                let built = menu::build(specs, &mut items).map_err(ApiError::invalid_params)?;
                skipped = built.skipped;
                self.forget(Scope::Tray);
                self.tray_menu_ids = items.keys().cloned().collect();
                self.items.extend(items);
                Some(built.menu)
            }
            None => None,
        };

        // Only `menu` lets the library handle the click; the others need the
        // event, so the runtime can decide between window and menu.
        let mut builder =
            TrayIconBuilder::new().with_menu_on_left_click(spec.left_click == TrayLeftClick::Menu);

        if let Some(path) = &spec.icon {
            builder = builder.with_icon(load_icon(rt, path)?);
        }
        if let Some(tooltip) = &spec.tooltip {
            builder = builder.with_tooltip(tooltip);
        }
        if let Some(menu) = menu.clone() {
            builder = builder.with_menu(Box::new(menu));
        }
        if spec.icon_as_template {
            builder = builder.with_icon_as_template(true);
        }

        // Replaced rather than mutated: the builder is the only place several
        // of these can be set at all.
        self.tray = Some(
            builder
                .build()
                .map_err(|e| ApiError::internal(format!("Could not create the tray icon: {e}")))?,
        );
        self.tray_menu = menu;
        self.left_click = spec.left_click;
        self.tray_window = spec.window.clone();

        #[cfg(target_os = "macos")]
        if let (Some(tray), Some(title)) = (&self.tray, &spec.title) {
            tray.set_title(Some(title));
        }

        Ok(skipped)
    }

    pub fn remove_tray(&mut self) {
        self.tray = None;
        self.tray_menu = None;
        self.forget(Scope::Tray);
    }

    pub fn tray_left_click(&self) -> TrayLeftClick {
        self.left_click
    }

    /// The window a tray click should bring back.
    pub fn tray_window(&self) -> &str {
        self.tray_window.as_deref().unwrap_or(crate::windows::MAIN)
    }

    /// Pop the tray menu open without waiting for a click on the icon.
    pub fn show_tray_menu(&self) -> Result<(), ApiError> {
        self.tray()?.show_menu();
        Ok(())
    }

    pub fn tray(&self) -> Result<&TrayIcon, ApiError> {
        self.tray.as_ref().ok_or_else(|| {
            ApiError::new(
                crate::error::code::NOT_FOUND,
                "There is no tray icon. Create one with `tray.set` or in vantail.config.ts.",
            )
        })
    }

    pub fn set_tray_menu(&mut self, specs: &[MenuSpec]) -> Result<Vec<String>, ApiError> {
        let mut items = HashMap::new();
        let menu::Built { menu, skipped } =
            menu::build(specs, &mut items).map_err(ApiError::invalid_params)?;

        self.forget(Scope::Tray);
        self.tray_menu_ids = items.keys().cloned().collect();
        self.items.extend(items);

        self.tray()?.set_menu(Some(Box::new(menu.clone())));
        self.tray_menu = Some(menu);
        Ok(skipped)
    }

    fn forget(&mut self, scope: Scope) {
        let ids = match scope {
            Scope::App => std::mem::take(&mut self.app_menu_ids),
            Scope::Tray => std::mem::take(&mut self.tray_menu_ids),
        };
        for id in ids {
            self.items.remove(&id);
        }
    }
}

enum Scope {
    App,
    Tray,
}

/// Resolve and decode a tray icon.
///
/// A relative path is an application asset. An absolute one has to be inside
/// the filesystem read scope, so `tray.setIcon` cannot be used to read a file
/// the application is otherwise not allowed to touch.
pub fn load_icon(rt: &Runtime, path: &str) -> Result<tray_icon::Icon, ApiError> {
    let resolved: PathBuf = if let Some(rest) = path.strip_prefix("$RESOURCE/") {
        rt.resource_dir.join(rest)
    } else if std::path::Path::new(path).is_absolute() {
        rt.permissions
            .check_path(path, crate::permissions::Access::Read)?
    } else {
        rt.resource_dir.join(path)
    };

    let image = icon::load_png(&resolved)?;
    tray_icon::Icon::from_rgba(image.bytes, image.width, image.height)
        .map_err(|e| ApiError::invalid_params(format!("Could not use {path} as an icon: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click(state: tray_icon::MouseButtonState) -> tray_icon::TrayIconEvent {
        tray_icon::TrayIconEvent::Click {
            id: tray_icon::TrayIconId::new("t"),
            position: tao::dpi::PhysicalPosition::new(12.0, 34.0),
            rect: tray_icon::Rect::default(),
            button: tray_icon::MouseButton::Left,
            button_state: state,
        }
    }

    #[test]
    fn one_click_is_one_event() {
        // `tray_icon` reports a press and a release as two `Click`s. Passing
        // both on gave listeners two `tray.click`s per click, which turned a
        // handler that toggles a window into one that opened and shut it.
        assert!(tray_message(&click(tray_icon::MouseButtonState::Down)).is_none());

        let (name, payload) = tray_message(&click(tray_icon::MouseButtonState::Up))
            .expect("the release is the click");
        assert_eq!(name, "tray.click");
        assert_eq!(payload["button"], "left");
        assert_eq!(payload["x"], 12.0);
        assert_eq!(payload["y"], 34.0);
    }

    #[test]
    fn hovering_is_not_forwarded() {
        // Enter, Move and Leave fire constantly and nobody has asked for them.
        let moved = tray_icon::TrayIconEvent::Move {
            id: tray_icon::TrayIconId::new("t"),
            position: tao::dpi::PhysicalPosition::new(1.0, 2.0),
            rect: tray_icon::Rect::default(),
        };
        assert!(tray_message(&moved).is_none());
    }

    const HIDDEN: WindowState = WindowState {
        visible: false,
        focused: false,
    };
    const BEHIND: WindowState = WindowState {
        visible: true,
        focused: false,
    };
    const IN_FRONT: WindowState = WindowState {
        visible: true,
        focused: true,
    };

    #[test]
    fn a_click_brings_a_hidden_window_back() {
        // The whole point of a tray icon for an application that hides rather
        // than closes.
        assert_eq!(
            tray_activation(TrayLeftClick::ShowWindow, Some(HIDDEN)),
            TrayActivation::ShowAndFocus
        );
    }

    #[test]
    fn a_click_raises_a_window_that_is_behind_something() {
        assert_eq!(
            tray_activation(TrayLeftClick::ShowWindow, Some(BEHIND)),
            TrayActivation::Focus
        );
    }

    #[test]
    fn a_click_opens_the_menu_when_the_window_is_already_in_front() {
        // Showing it again would do nothing visible, so the click gets to
        // mean something else.
        assert_eq!(
            tray_activation(TrayLeftClick::ShowWindow, Some(IN_FRONT)),
            TrayActivation::ShowMenu
        );
    }

    #[test]
    fn a_click_opens_the_menu_when_there_is_no_window_to_show() {
        assert_eq!(
            tray_activation(TrayLeftClick::ShowWindow, None),
            TrayActivation::ShowMenu
        );
    }

    #[test]
    fn the_other_modes_leave_the_click_alone() {
        // `menu` is handled inside tray-icon, and `event` is deliberately the
        // application's decision.
        for state in [HIDDEN, BEHIND, IN_FRONT] {
            assert_eq!(
                tray_activation(TrayLeftClick::Menu, Some(state)),
                TrayActivation::Nothing
            );
            assert_eq!(
                tray_activation(TrayLeftClick::Event, Some(state)),
                TrayActivation::Nothing
            );
        }
    }
}
