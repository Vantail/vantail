//! Menu descriptions, and turning them into native menus.
//!
//! One description language serves both the application menu and the tray
//! menu, because from JavaScript they are the same thing in two places.

use std::collections::HashMap;
use std::str::FromStr;

use muda::accelerator::Accelerator;
use muda::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use serde::Deserialize;

/// One entry in a menu.
///
/// `type` is always explicit on the wire. `@vantail/api` fills in `normal`
/// when an application leaves it out, so the runtime never has to guess.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MenuSpec {
    Normal {
        id: String,
        label: String,
        #[serde(default = "yes")]
        enabled: bool,
        /// e.g. `CmdOrCtrl+S`, `Alt+Shift+F4`.
        #[serde(default)]
        accelerator: Option<String>,
    },
    Checkbox {
        id: String,
        label: String,
        #[serde(default)]
        checked: bool,
        #[serde(default = "yes")]
        enabled: bool,
        #[serde(default)]
        accelerator: Option<String>,
    },
    Submenu {
        label: String,
        #[serde(default = "yes")]
        enabled: bool,
        #[serde(default)]
        items: Vec<MenuSpec>,
    },
    Separator,
    /// A platform-provided item. These are not optional decoration on macOS:
    /// without `copy`, `paste` and friends in the menu, their keyboard
    /// shortcuts do not work at all.
    Predefined {
        item: String,
        #[serde(default)]
        label: Option<String>,
    },
}

fn yes() -> bool {
    true
}

/// The menu macOS applications are expected to have.
///
/// Installed when an application sets none of its own, because on macOS a
/// missing menu is not a cosmetic difference: without it Cmd-W, Cmd-Q, Cmd-C,
/// Cmd-V, Cmd-Z and Cmd-M do nothing whatsoever. Every item here is a
/// platform-provided one, so the shortcuts, labels and localisation are the
/// system's rather than ours.
///
/// An application that wants no menu at all can say so with `menu: []`.
pub fn default_app_menu(app_name: &str) -> Vec<MenuSpec> {
    let predefined = |item: &str| MenuSpec::Predefined {
        item: item.to_string(),
        label: None,
    };

    vec![
        MenuSpec::Submenu {
            label: app_name.to_string(),
            enabled: true,
            items: vec![
                predefined("about"),
                MenuSpec::Separator,
                predefined("services"),
                MenuSpec::Separator,
                predefined("hide"),
                predefined("hideOthers"),
                predefined("showAll"),
                MenuSpec::Separator,
                predefined("quit"),
            ],
        },
        MenuSpec::Submenu {
            label: "Edit".to_string(),
            enabled: true,
            items: vec![
                predefined("undo"),
                predefined("redo"),
                MenuSpec::Separator,
                predefined("cut"),
                predefined("copy"),
                predefined("paste"),
                predefined("selectAll"),
            ],
        },
        MenuSpec::Submenu {
            label: "Window".to_string(),
            enabled: true,
            items: vec![
                predefined("minimize"),
                predefined("closeWindow"),
                MenuSpec::Separator,
                predefined("fullscreen"),
            ],
        },
    ]
}

/// A live menu item, kept so it can be enabled, checked or relabelled later.
pub enum ItemHandle {
    Normal(MenuItem),
    Checkbox(CheckMenuItem),
    Submenu(Submenu),
}

impl ItemHandle {
    pub fn set_enabled(&self, enabled: bool) {
        match self {
            ItemHandle::Normal(item) => item.set_enabled(enabled),
            ItemHandle::Checkbox(item) => item.set_enabled(enabled),
            ItemHandle::Submenu(item) => item.set_enabled(enabled),
        }
    }

    pub fn set_label(&self, label: &str) {
        match self {
            ItemHandle::Normal(item) => item.set_text(label),
            ItemHandle::Checkbox(item) => item.set_text(label),
            ItemHandle::Submenu(item) => item.set_text(label),
        }
    }

    pub fn set_checked(&self, checked: bool) -> bool {
        match self {
            ItemHandle::Checkbox(item) => {
                item.set_checked(checked);
                true
            }
            _ => false,
        }
    }

    pub fn is_checked(&self) -> Option<bool> {
        match self {
            ItemHandle::Checkbox(item) => Some(item.is_checked()),
            _ => None,
        }
    }
}

/// Build a native menu, recording every addressable item by id.
pub fn build(specs: &[MenuSpec], items: &mut HashMap<String, ItemHandle>) -> Result<Menu, String> {
    let menu = Menu::new();
    for spec in specs {
        append(&menu, spec, items)?;
    }
    Ok(menu)
}

fn append(
    menu: &dyn Container,
    spec: &MenuSpec,
    items: &mut HashMap<String, ItemHandle>,
) -> Result<(), String> {
    match spec {
        MenuSpec::Separator => menu.add(&PredefinedMenuItem::separator()),

        MenuSpec::Normal {
            id,
            label,
            enabled,
            accelerator,
        } => {
            let item = MenuItem::with_id(id.clone(), label, *enabled, parse(accelerator)?);
            menu.add(&item)?;
            items.insert(id.clone(), ItemHandle::Normal(item));
            Ok(())
        }

        MenuSpec::Checkbox {
            id,
            label,
            checked,
            enabled,
            accelerator,
        } => {
            let item =
                CheckMenuItem::with_id(id.clone(), label, *enabled, *checked, parse(accelerator)?);
            menu.add(&item)?;
            items.insert(id.clone(), ItemHandle::Checkbox(item));
            Ok(())
        }

        MenuSpec::Submenu {
            label,
            enabled,
            items: children,
        } => {
            let submenu = Submenu::new(label, *enabled);
            for child in children {
                append(&submenu, child, items)?;
            }
            menu.add(&submenu)?;
            // Submenus are addressable by label, since they carry no id of
            // their own and enabling a whole menu is a real thing to want.
            items.insert(label.clone(), ItemHandle::Submenu(submenu));
            Ok(())
        }

        MenuSpec::Predefined { item, label } => menu.add(&predefined(item, label.as_deref())?),
    }
}

/// `Menu` and `Submenu` both take items but share no trait that says so.
trait Container {
    fn add(&self, item: &dyn muda::IsMenuItem) -> Result<(), String>;
}

impl Container for Menu {
    fn add(&self, item: &dyn muda::IsMenuItem) -> Result<(), String> {
        self.append(item).map_err(|e| e.to_string())
    }
}

impl Container for Submenu {
    fn add(&self, item: &dyn muda::IsMenuItem) -> Result<(), String> {
        self.append(item).map_err(|e| e.to_string())
    }
}

fn parse(accelerator: &Option<String>) -> Result<Option<Accelerator>, String> {
    accelerator
        .as_deref()
        .map(|text| {
            Accelerator::from_str(text).map_err(|e| format!("Invalid accelerator `{text}`: {e}"))
        })
        .transpose()
}

fn predefined(name: &str, label: Option<&str>) -> Result<PredefinedMenuItem, String> {
    Ok(match name {
        "separator" => PredefinedMenuItem::separator(),
        "copy" => PredefinedMenuItem::copy(label),
        "cut" => PredefinedMenuItem::cut(label),
        "paste" => PredefinedMenuItem::paste(label),
        "selectAll" => PredefinedMenuItem::select_all(label),
        "undo" => PredefinedMenuItem::undo(label),
        "redo" => PredefinedMenuItem::redo(label),
        "minimize" => PredefinedMenuItem::minimize(label),
        "maximize" => PredefinedMenuItem::maximize(label),
        "fullscreen" => PredefinedMenuItem::fullscreen(label),
        "hide" => PredefinedMenuItem::hide(label),
        "hideOthers" => PredefinedMenuItem::hide_others(label),
        "showAll" => PredefinedMenuItem::show_all(label),
        "closeWindow" => PredefinedMenuItem::close_window(label),
        "quit" => PredefinedMenuItem::quit(label),
        "about" => PredefinedMenuItem::about(label, None),
        "services" => PredefinedMenuItem::services(label),
        "bringAllToFront" => PredefinedMenuItem::bring_all_to_front(label),
        other => {
            return Err(format!(
                "Unknown predefined menu item `{other}`. See the menu documentation for the list."
            ))
        }
    })
}
