//! `app.*` - identity and lifecycle.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::ipc::{Event, Outgoing, Request};
use crate::state::MainCtx;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmitParams {
    event: String,
    #[serde(default)]
    payload: Value,
    /// Window label to deliver to. Every window when omitted.
    #[serde(default)]
    to: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BadgeParams {
    /// `null` clears it.
    #[serde(default)]
    label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgressParams {
    /// 0 to 100. Omitted leaves it where it is.
    #[serde(default)]
    value: Option<u64>,
    /// `none`, `normal`, `indeterminate`, `paused` or `error`.
    #[serde(default)]
    state: Option<String>,
}

pub fn dispatch(ctx: &mut MainCtx<'_>, method: &str, params: Value) -> ApiResult {
    if method == "app.emit" {
        return emit(ctx, params);
    }

    if method == "app.setBadge" {
        ctx.rt
            .permissions
            .require(ctx.rt.permissions.window, method)?;
        let BadgeParams { label } = Request::params(method, params)?;
        return set_badge(ctx, label);
    }

    if method == "app.setProgress" {
        ctx.rt
            .permissions
            .require(ctx.rt.permissions.window, method)?;
        let ProgressParams { value, state } = Request::params(method, params)?;
        return set_progress(ctx, value, state.as_deref());
    }

    let app = &ctx.rt.config.app;

    match method {
        "app.name" => Ok(json!(app.name)),
        "app.version" => Ok(json!(app.version)),
        "app.identifier" => Ok(json!(app.identifier)),
        "app.isDev" => Ok(json!(ctx.rt.is_dev())),
        "app.info" => Ok(json!({
            "name": app.name,
            "version": app.version,
            "identifier": app.identifier,
            "isDev": ctx.rt.is_dev(),
        })),
        "app.quit" => {
            *ctx.exit = true;
            Ok(Value::Null)
        }
        "app.restart" => restart(),
        _ => Err(ApiError::unknown_method(method)),
    }
}

/// Deliver an application-defined event to one window or all of them.
///
/// User events travel under a `user:` prefix so that an application can name
/// its events anything at all without colliding with `window.resized` and
/// friends.
fn emit(ctx: &mut MainCtx<'_>, params: Value) -> ApiResult {
    let EmitParams { event, payload, to } = Request::params("app.emit", params)?;

    if let Some(label) = &to {
        ctx.windows.require(label)?;
    }

    let outgoing = Outgoing::Event(Event::new(
        format!("user:{event}"),
        json!({ "from": ctx.source, "payload": payload }),
    ));
    ctx.windows.deliver(to.as_deref(), &outgoing);

    Ok(Value::Null)
}

/// Re-exec the current binary with the same arguments, then exit.
///
/// The child is spawned before we quit so the new window appears as the old
/// one goes away rather than after a visible gap.
fn restart() -> ApiResult {
    let exe = std::env::current_exe()
        .map_err(|e| ApiError::io("Could not locate the running executable", e))?;
    let args: Vec<String> = std::env::args().skip(1).collect();

    std::process::Command::new(exe)
        .args(args)
        .spawn()
        .map_err(|e| ApiError::io("Could not restart the application", e))?;

    std::process::exit(0);
}

/// The count on the application's icon.
///
/// macOS takes any text; Linux takes a number, so a label that is not one
/// cannot be shown there. Windows has no text badge at all - only an overlay
/// icon, which is a different thing with a different API.
// Each platform is its own block, so on any one of them the others vanish and
// the first `return` becomes the last statement.
#[allow(clippy::needless_return)]
fn set_badge(ctx: &mut MainCtx<'_>, label: Option<String>) -> ApiResult {
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::EventLoopWindowTargetExtMacOS;
        ctx.target.set_badge_label(label);
        return Ok(Value::Null);
    }

    #[cfg(target_os = "linux")]
    {
        use tao::platform::unix::WindowExtUnix;

        let count = match label.as_deref() {
            None => None,
            Some(text) => Some(text.parse::<i64>().map_err(|_| {
                ApiError::invalid_params(format!(
                    "This platform's badge is a number, and `{text}` is not one"
                ))
            })?),
        };

        let desktop = format!("{}.desktop", ctx.rt.config.app.identifier);
        ctx.windows
            .require(ctx.source)?
            .window
            .set_badge_count(count, Some(desktop));
        return Ok(Value::Null);
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (ctx, label);
        Err(ApiError::unsupported(
            "Windows has no text badge. Use app.setProgress, or a tray icon.",
        ))
    }
}

/// The bar drawn across the application's icon or taskbar button.
fn set_progress(ctx: &mut MainCtx<'_>, value: Option<u64>, state: Option<&str>) -> ApiResult {
    use tao::window::{ProgressBarState, ProgressState};

    if let Some(value) = value {
        if value > 100 {
            return Err(ApiError::invalid_params(format!(
                "Progress is 0 to 100, and this is {value}"
            )));
        }
    }

    let state = match state {
        None => None,
        Some("none") => Some(ProgressState::None),
        Some("normal") => Some(ProgressState::Normal),
        Some("indeterminate") => Some(ProgressState::Indeterminate),
        Some("paused") => Some(ProgressState::Paused),
        Some("error") => Some(ProgressState::Error),
        Some(other) => {
            return Err(ApiError::invalid_params(format!(
            "`{other}` is not a progress state. Use none, normal, indeterminate, paused or error."
        )))
        }
    };

    ctx.windows
        .require(ctx.source)?
        .window
        .set_progress_bar(ProgressBarState {
            state,
            progress: value,
            desktop_filename: Some(format!("{}.desktop", ctx.rt.config.app.identifier)),
        });

    Ok(Value::Null)
}
