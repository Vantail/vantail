//! `tray.*` - the menu bar / system tray icon.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::chrome::menu::MenuSpec;
use crate::chrome::TraySpec;
use crate::error::{ApiError, ApiResult};
use crate::ipc::Request;
use crate::state::MainCtx;

#[derive(Deserialize)]
struct IconParams {
    /// PNG path. Relative to the application's resources unless absolute.
    icon: String,
    #[serde(default)]
    template: Option<bool>,
}

#[derive(Deserialize)]
struct TooltipParams {
    tooltip: Option<String>,
}

#[derive(Deserialize)]
struct TitleParams {
    title: Option<String>,
}

#[derive(Deserialize)]
struct VisibleParams {
    visible: bool,
}

#[derive(Deserialize)]
struct MenuParams {
    items: Vec<MenuSpec>,
}

pub fn dispatch(ctx: &mut MainCtx<'_>, method: &str, params: Value) -> ApiResult {
    ctx.rt
        .permissions
        .require(ctx.rt.permissions.tray, method)?;

    match method {
        "tray.set" => {
            let spec: TraySpec = Request::params(method, params)?;
            ctx.chrome.set_tray(ctx.rt, &spec)?;
            Ok(Value::Null)
        }

        "tray.remove" => {
            ctx.chrome.remove_tray();
            Ok(Value::Null)
        }

        "tray.exists" => Ok(json!(ctx.chrome.has_tray())),

        "tray.setIcon" => {
            let IconParams { icon, template } = Request::params(method, params)?;
            let icon = crate::chrome::load_icon(ctx.rt, &icon)?;
            let tray = ctx.chrome.tray()?;
            match template {
                Some(template) => tray
                    .set_icon_with_as_template(Some(icon), template)
                    .map_err(|e| ApiError::internal(format!("Could not set the tray icon: {e}")))?,
                None => tray
                    .set_icon(Some(icon))
                    .map_err(|e| ApiError::internal(format!("Could not set the tray icon: {e}")))?,
            }
            Ok(Value::Null)
        }

        "tray.setTooltip" => {
            let TooltipParams { tooltip } = Request::params(method, params)?;
            ctx.chrome
                .tray()?
                .set_tooltip(tooltip.as_deref())
                .map_err(|e| ApiError::internal(format!("Could not set the tooltip: {e}")))?;
            Ok(Value::Null)
        }

        "tray.setTitle" => {
            let TitleParams { title } = Request::params(method, params)?;
            let _tray = ctx.chrome.tray()?;
            #[cfg(target_os = "macos")]
            _tray.set_title(title.as_deref());
            #[cfg(not(target_os = "macos"))]
            let _ = title;
            Ok(Value::Null)
        }

        "tray.setVisible" => {
            let VisibleParams { visible } = Request::params(method, params)?;
            ctx.chrome
                .tray()?
                .set_visible(visible)
                .map_err(|e| ApiError::internal(format!("Could not change visibility: {e}")))?;
            Ok(Value::Null)
        }

        "tray.showMenu" => {
            ctx.chrome.show_tray_menu()?;
            Ok(Value::Null)
        }

        "tray.setMenu" => {
            let MenuParams { items } = Request::params(method, params)?;
            ctx.chrome.set_tray_menu(&items)?;
            Ok(Value::Null)
        }

        _ => Err(ApiError::unknown_method(method)),
    }
}
