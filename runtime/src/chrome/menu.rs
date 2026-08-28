//! Menu descriptions, and turning them into native menus.
//!
//! One description language serves both the application menu and the tray
//! menu, because from JavaScript they are the same thing in two places.

use std::collections::HashMap;
use std::str::FromStr;

use muda::accelerator::Accelerator;
use muda::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use serde::Deserialize;

/// The id the runtime gives its own Quit item.
///
/// `quit` is asked for as a predefined item, but it cannot be one: muda's
/// predefined quit is the platform's own terminate, which tears the process
/// down from under the event loop instead of unwinding it. From a tray menu,
/// which runs its own modal tracking loop on macOS, that wedges rather than
/// quits. So the item is an ordinary one with a reserved id, and the loop
/// treats it exactly as it treats `app.quit`.
pub const QUIT_ID: &str = "vantail:quit";

/// The application's name, for the label macOS expects on that item.
static APP_NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Remembered once at startup, since every menu built later wants it.
pub fn remember_app_name(name: &str) {
    let _ = APP_NAME.set(name.to_string());
}

/// Pure so it can be checked without a window server.
fn quit_label(given: Option<&str>, app: Option<&str>) -> String {
    match (given, app) {
        (Some(label), _) => label.to_string(),
        (None, Some(name)) => format!("Quit {name}"),
        (None, None) => "Quit".to_string(),
    }
}

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

/// A built menu, and whatever had to be left out of it.
pub struct Built {
    pub menu: Menu,
    /// One line per item that could not be created, in the order they were
    /// found. Empty in the ordinary case.
    pub skipped: Vec<String>,
}

/// Build a native menu, recording every addressable item by id.
///
/// An item the platform will not accept - an accelerator it cannot parse, a
/// predefined item it does not know - is left out rather than failing the
/// whole menu. On macOS a menu that fails to install takes Cmd-C, Cmd-V,
/// Cmd-Q and Cmd-W down with it, because those shortcuts exist only as menu
/// items: losing all of them over one mistyped accelerator is far worse than
/// losing the item that was mistyped. What was skipped comes back, so the
/// caller can say which item went missing instead of leaving it a mystery.
///
/// A failure from the platform itself is still an error - that is a broken
/// menu rather than a typo in a config file.
pub fn build(specs: &[MenuSpec], items: &mut HashMap<String, ItemHandle>) -> Result<Built, String> {
    let menu = Menu::new();
    let mut skipped = Vec::new();
    for spec in specs {
        append(&menu, spec, items, &mut skipped)?;
    }
    Ok(Built { menu, skipped })
}

fn append(
    menu: &dyn Container,
    spec: &MenuSpec,
    items: &mut HashMap<String, ItemHandle>,
    skipped: &mut Vec<String>,
) -> Result<(), String> {
    match spec {
        MenuSpec::Separator => menu.add(&PredefinedMenuItem::separator()),

        MenuSpec::Normal {
            id,
            label,
            enabled,
            accelerator,
        } => {
            let accelerator = match parse(accelerator) {
                Ok(accelerator) => accelerator,
                Err(error) => {
                    skipped.push(format!("`{label}` (id `{id}`): {error}"));
                    return Ok(());
                }
            };
            let item = MenuItem::with_id(id.clone(), label, *enabled, accelerator);
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
            let accelerator = match parse(accelerator) {
                Ok(accelerator) => accelerator,
                Err(error) => {
                    skipped.push(format!("`{label}` (id `{id}`): {error}"));
                    return Ok(());
                }
            };
            let item = CheckMenuItem::with_id(id.clone(), label, *enabled, *checked, accelerator);
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
                append(&submenu, child, items, skipped)?;
            }
            menu.add(&submenu)?;
            // Submenus are addressable by label, since they carry no id of
            // their own and enabling a whole menu is a real thing to want.
            items.insert(label.clone(), ItemHandle::Submenu(submenu));
            Ok(())
        }

        MenuSpec::Predefined { item, label } => {
            // Everything else muda can do natively. Quit is ours.
            if item == "quit" {
                let item = MenuItem::with_id(
                    QUIT_ID,
                    quit_label(label.as_deref(), APP_NAME.get().map(String::as_str)),
                    true,
                    parse(&Some("CmdOrCtrl+Q".to_string()))?,
                );
                menu.add(&item)?;
                items.insert(QUIT_ID.to_string(), ItemHandle::Normal(item));
                return Ok(());
            }
            match predefined(item, label.as_deref()) {
                Ok(built) => menu.add(&built),
                Err(error) => {
                    skipped.push(error);
                    Ok(())
                }
            }
        }
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
            Accelerator::from_str(&alias(text))
                .map_err(|e| format!("Invalid accelerator `{text}`: {e}"))
        })
        .transpose()
}

/// Accept the names an Apple keyboard prints for keys the web platform calls
/// something else.
///
/// muda speaks `KeyboardEvent.code`, where the big key on the right of the
/// home row is `Enter`. Every Mac keyboard has `return` written on it, so
/// that is what somebody writing a macOS-first application types - and until
/// now it took the entire menu down with it.
fn alias(text: &str) -> String {
    match text.rsplit_once('+') {
        // `Ctrl++` means the `+` key itself: the split leaves no key name
        // behind, so there is nothing here to rewrite.
        Some((_, key)) if key.trim().is_empty() => text.to_string(),
        Some((modifiers, key)) => format!("{modifiers}+{}", key_alias(key.trim())),
        None => key_alias(text.trim()).to_string(),
    }
}

fn key_alias(key: &str) -> &str {
    if key.eq_ignore_ascii_case("return") {
        return "Enter";
    }
    key
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_is_no_longer_something_muda_provides() {
        // `append` intercepts it and builds an ordinary item instead, because
        // the platform's own terminate does not unwind the event loop. If
        // that interception is ever dropped, this is what refuses to let it
        // quietly go back to the broken one.
        assert!(
            predefined("quit", None).is_err(),
            "quit reached the predefined builder, which means it is the platform's again"
        );
    }

    #[test]
    fn the_quit_item_is_labelled_the_way_the_platform_expects() {
        assert_eq!(
            quit_label(None, Some("Vantail Showcase")),
            "Quit Vantail Showcase"
        );
        // A config may say what it wants instead.
        assert_eq!(quit_label(Some("Leave"), Some("Showcase")), "Leave");
        // Before the name is known, which is better than an empty label.
        assert_eq!(quit_label(None, None), "Quit");
    }

    #[test]
    fn return_is_accepted_as_the_name_apple_prints_on_the_key() {
        // The report that prompted this: `CmdOrCtrl+Return` took the whole
        // menu down, and with it Cmd-Q, Cmd-C and Cmd-V.
        assert_eq!(alias("CmdOrCtrl+Return"), "CmdOrCtrl+Enter");
        assert_eq!(alias("Return"), "Enter");
        // Case is not what a developer should have to get right.
        assert_eq!(alias("Shift+RETURN"), "Shift+Enter");
        assert!(parse(&Some("CmdOrCtrl+Return".to_string())).is_ok());
    }

    #[test]
    fn a_plus_key_survives_the_rewrite() {
        // `Ctrl++` is the `+` key, and the split that finds the key name
        // leaves nothing behind. Rewriting it would silently change which
        // shortcut the item got.
        assert_eq!(alias("Ctrl++"), "Ctrl++");
        assert_eq!(alias("+"), "+");
    }

    #[test]
    fn only_the_key_is_aliased_not_a_modifier_that_reads_the_same() {
        // `Enter` still works, and nothing else is rewritten.
        assert_eq!(alias("CmdOrCtrl+Enter"), "CmdOrCtrl+Enter");
        assert_eq!(alias("CmdOrCtrl+S"), "CmdOrCtrl+S");
        assert_eq!(alias("Alt+Shift+F4"), "Alt+Shift+F4");
    }

    #[test]
    fn an_accelerator_that_means_nothing_is_still_an_error() {
        // Skipping the item depends on this failing rather than silently
        // producing something wrong.
        let error = parse(&Some("CmdOrCtrl+Nonsense".to_string())).unwrap_err();
        assert!(error.contains("Nonsense"), "{error}");
    }

    #[test]
    fn no_accelerator_is_not_an_error() {
        assert!(matches!(parse(&None), Ok(None)));
    }

    #[test]
    fn the_reserved_id_is_namespaced() {
        // An application's own item with this id would be shadowed by the
        // runtime's handling, so it has to be one nobody would pick.
        assert!(
            QUIT_ID.contains(':'),
            "{QUIT_ID} could collide with an application's own id"
        );
    }
}
