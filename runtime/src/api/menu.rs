//! `menu.*` - the application menu, and context menus.
//!
//! On macOS this is the menu bar, and it is not decoration: without the
//! predefined `copy`, `paste`, `undo` and `selectAll` items in it, those
//! keyboard shortcuts do not work anywhere in the application. A Vantail app
//! that wants working Cmd-C sets a menu.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::chrome::menu::MenuSpec;
use crate::error::{ApiError, ApiResult};
use crate::ipc::Request;
use crate::state::MainCtx;

#[derive(Deserialize)]
struct Items {
    items: Vec<MenuSpec>,
}

#[derive(Deserialize)]
struct SetEnabled {
    id: String,
    enabled: bool,
}

#[derive(Deserialize)]
struct SetChecked {
    id: String,
    checked: bool,
}

#[derive(Deserialize)]
struct SetLabel {
    id: String,
    label: String,
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Popup {
    items: Vec<MenuSpec>,
    /// Where to show it, in logical pixels relative to the window. The cursor
    /// position when omitted.
    x: Option<f64>,
    y: Option<f64>,
    label: Option<String>,
}

pub fn dispatch(ctx: &mut MainCtx<'_>, method: &str, params: Value) -> ApiResult {
    ctx.rt
        .permissions
        .require(ctx.rt.permissions.menu, method)?;

    match method {
        "menu.set" => {
            let Items { items } = Request::params(method, params)?;
            ctx.chrome.set_app_menu(&items)?;
            // Windows attaches the menu per window rather than per app.
            for label in ctx.windows.labels() {
                if let Some(entry) = ctx.windows.get(&label) {
                    ctx.chrome.attach(&entry.window);
                }
            }
            Ok(Value::Null)
        }

        "menu.remove" => {
            ctx.chrome.remove_app_menu();
            Ok(Value::Null)
        }

        "menu.setEnabled" => {
            let SetEnabled { id, enabled } = Request::params(method, params)?;
            item(ctx, &id)?.set_enabled(enabled);
            Ok(Value::Null)
        }

        "menu.setLabel" => {
            let SetLabel { id, label } = Request::params(method, params)?;
            item(ctx, &id)?.set_label(&label);
            Ok(Value::Null)
        }

        "menu.setChecked" => {
            let SetChecked { id, checked } = Request::params(method, params)?;
            if !item(ctx, &id)?.set_checked(checked) {
                return Err(ApiError::invalid_params(format!(
                    "`{id}` is not a checkbox item"
                )));
            }
            Ok(Value::Null)
        }

        "menu.isChecked" => {
            let Id { id } = Request::params(method, params)?;
            item(ctx, &id)?
                .is_checked()
                .map(|checked| json!(checked))
                .ok_or_else(|| ApiError::invalid_params(format!("`{id}` is not a checkbox item")))
        }

        "menu.popup" => popup(ctx, params),

        _ => Err(ApiError::unknown_method(method)),
    }
}

fn item<'a>(
    ctx: &'a MainCtx<'_>,
    id: &str,
) -> Result<&'a crate::chrome::menu::ItemHandle, ApiError> {
    ctx.chrome.item(id).ok_or_else(|| {
        ApiError::new(
            crate::error::code::NOT_FOUND,
            format!("No menu item with id `{id}`"),
        )
    })
}

#[allow(unused_variables)]
fn popup(ctx: &mut MainCtx<'_>, params: Value) -> ApiResult {
    let params: Popup = Request::params("menu.popup", params)?;
    if params.items.is_empty() {
        return Err(ApiError::invalid_params("`items` cannot be empty"));
    }

    let label = params.label.unwrap_or_else(|| ctx.source.to_string());
    let entry = ctx.windows.require(&label)?;

    // A throwaway menu: the platform call below is modal, so it stays alive
    // for exactly as long as it is on screen.
    let mut handles = std::collections::HashMap::new();
    let menu = crate::chrome::menu::build(&params.items, &mut handles)
        .map_err(ApiError::invalid_params)?;

    // Annotated rather than inferred: only the platform-specific calls below
    // pin this type, so on a platform where none of them compile there is
    // nothing left to infer it from.
    let position: Option<muda::dpi::Position> = match (params.x, params.y) {
        (Some(x), Some(y)) => Some(muda::dpi::LogicalPosition::new(x, y).into()),
        _ => None,
    };

    #[cfg(target_os = "macos")]
    {
        use muda::ContextMenu;
        use tao::platform::macos::WindowExtMacOS;
        // Safety: the view comes straight from the window we just looked up,
        // and the call returns before this function does.
        unsafe {
            menu.show_context_menu_for_nsview(entry.window.ns_view(), position);
        }
        return Ok(Value::Null);
    }

    #[cfg(target_os = "windows")]
    {
        use muda::ContextMenu;
        use tao::platform::windows::WindowExtWindows;
        // Safety: the handle belongs to the window we just looked up.
        unsafe {
            menu.show_context_menu_for_hwnd(entry.window.hwnd(), position);
        }
        return Ok(Value::Null);
    }

    #[allow(unreachable_code)]
    Err(ApiError::unsupported(
        "Context menus are not implemented on this platform yet",
    ))
}
