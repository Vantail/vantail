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

pub fn dispatch(
    ctx: &mut MainCtx<'_>,
    method: &str,
    params: Value,
) -> ApiResult {
    ctx.rt
        .permissions
        .require(ctx.rt.permissions.tray, method)?;

    match method {
        "tray.set" => set(ctx, params),
        "tray.remove" => remove(ctx),
        "tray.exists" => Ok(json!(ctx.chrome.has_tray())),
        "tray.setIcon" => set_icon(ctx, params),
        "tray.setTooltip" => set_tooltip(ctx, params),
        "tray.setTitle" => set_title(ctx, params),
        "tray.setVisible" => set_visible(ctx, params),
        "tray.showMenu" => show_menu(ctx),
        "tray.setMenu" => set_menu(ctx, params),
        _ => Err(ApiError::unknown_method(method)),
    }
}

fn set(ctx: &mut MainCtx<'_>, params: Value) -> ApiResult {
    let spec: TraySpec = Request::params("tray.set", params)?;
    let skipped = ctx.chrome.set_tray(ctx.rt, &spec)?;
    Ok(json!({ "skipped": skipped }))
}

fn remove(ctx: &mut MainCtx<'_>) -> ApiResult {
    ctx.chrome.remove_tray();
    Ok(Value::Null)
}

fn set_icon(ctx: &mut MainCtx<'_>, params: Value) -> ApiResult {
    let IconParams { icon, template } =
        Request::params("tray.setIcon", params)?;
    let icon = crate::chrome::load_icon(ctx.rt, &icon)?;
    let tray = ctx.chrome.tray()?;
    // Leaving `template` out keeps the icon drawn the way it already was. A
    // plain `set_icon` would quietly turn a template icon into a coloured
    // one, so the current state has to be read first.
    #[cfg(target_os = "macos")]
    let templated = match template {
        Some(templated) => templated,
        None => tray.icon_is_template(),
    };
    #[cfg(target_os = "macos")]
    let set = if templated {
        tray.set_icon_templated(Some(icon))
    } else {
        tray.set_icon(Some(icon))
    };
    // Template images are a macOS idea; elsewhere the icon is drawn as-is.
    #[cfg(not(target_os = "macos"))]
    let set = {
        let _ = template;
        tray.set_icon(Some(icon))
    };
    set.map_err(|e| {
        ApiError::internal(format!("Could not set the tray icon: {e}"))
    })?;
    Ok(Value::Null)
}

fn set_tooltip(ctx: &mut MainCtx<'_>, params: Value) -> ApiResult {
    let TooltipParams { tooltip } = Request::params("tray.setTooltip", params)?;
    ctx.chrome
        .tray()?
        .set_tooltip(tooltip.as_deref())
        .map_err(|e| {
            ApiError::internal(format!("Could not set the tooltip: {e}"))
        })?;
    Ok(Value::Null)
}

/// The text beside the icon in the menu bar. macOS only; elsewhere a tray icon
/// has no title, so this checks there is a tray and does nothing else.
fn set_title(ctx: &mut MainCtx<'_>, params: Value) -> ApiResult {
    let TitleParams { title } = Request::params("tray.setTitle", params)?;
    let _tray = ctx.chrome.tray()?;
    #[cfg(target_os = "macos")]
    _tray.set_title(title.as_deref());
    #[cfg(not(target_os = "macos"))]
    let _ = title;
    Ok(Value::Null)
}

fn set_visible(ctx: &mut MainCtx<'_>, params: Value) -> ApiResult {
    let VisibleParams { visible } = Request::params("tray.setVisible", params)?;
    ctx.chrome.tray()?.set_visible(visible).map_err(|e| {
        ApiError::internal(format!("Could not change visibility: {e}"))
    })?;
    Ok(Value::Null)
}

fn show_menu(ctx: &mut MainCtx<'_>) -> ApiResult {
    ctx.chrome.show_tray_menu()?;
    Ok(Value::Null)
}

fn set_menu(ctx: &mut MainCtx<'_>, params: Value) -> ApiResult {
    let MenuParams { items } = Request::params("tray.setMenu", params)?;
    let skipped = ctx.chrome.set_tray_menu(&items)?;
    Ok(json!({ "skipped": skipped }))
}
