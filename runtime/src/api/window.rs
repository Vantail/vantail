//! `window.*` - the application's windows.
//!
//! Every method acts on the window that called it unless the call names a
//! different one with `label`. That keeps the common case - an app with one
//! window, or a window adjusting itself - free of ceremony, while still
//! letting any window drive any other.

use serde::Deserialize;
use serde_json::{json, Value};
use tao::dpi::{LogicalPosition, LogicalSize};
use tao::window::Fullscreen;

use crate::config::{CloseBehavior, WindowConfig};
use crate::error::{ApiError, ApiResult};
use crate::ipc::{Event, Outgoing, Request};
use crate::state::MainCtx;
use crate::windows;

#[derive(Deserialize, Default)]
#[serde(default)]
struct Target {
    label: Option<String>,
}

#[derive(Deserialize)]
struct Title {
    title: String,
}

#[derive(Deserialize)]
struct Size {
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
struct Position {
    x: f64,
    y: f64,
}

#[derive(Deserialize)]
struct Flag {
    value: bool,
}

#[derive(Deserialize)]
struct Style {
    style: crate::config::TitleBarStyle,
}

#[derive(Deserialize)]
struct Buttons {
    buttons: crate::config::TitleBarButtons,
}

#[derive(Deserialize)]
struct Height {
    /// `None` means the platform's own.
    #[serde(default)]
    height: Option<f64>,
}

#[derive(Deserialize)]
struct Behaviour {
    behavior: CloseBehavior,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    label: String,
    /// Path within the application, e.g. `settings.html` or `/#/settings`.
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    window: WindowConfig,
}

#[derive(Debug, serde::Deserialize)]
struct Limit {
    width: Option<f64>,
    height: Option<f64>,
}

#[derive(Debug, serde::Deserialize)]
struct Toggle {
    value: bool,
}

/// A limit is only a limit if both dimensions are given: tao takes one size,
/// not a width and a height that can be constrained separately.
fn size_limit(width: Option<f64>, height: Option<f64>) -> Option<LogicalSize<f64>> {
    match (width, height) {
        (Some(width), Some(height)) => Some(LogicalSize::new(width, height)),
        _ => None,
    }
}

/// Maximise or restore, keeping size limits out of the way while maximised.
///
/// A maximised window has to be exactly the size the window system chose. On
/// Wayland that is not a preference: the compositor sends a configure, and a
/// surface that then commits a different geometry is killed for violating
/// xdg-shell -
///
///   xdg_surface geometry (468 x 328) does not match the configured
///   maximized state (1400 x 968)
///
/// which takes the whole application with it. A maximum smaller than the
/// screen does not constrain maximising there anyway, so dropping the limits
/// while maximised costs nothing and removes the way to be killed. They go
/// back on when the window is restored.
fn set_maximized(entry: &mut crate::windows::WindowEntry, maximized: bool) {
    if maximized {
        entry.window.set_min_inner_size(NO_LIMIT);
        entry.window.set_max_inner_size(NO_LIMIT);
        entry.window.set_maximized(true);
        return;
    }

    entry.window.set_maximized(false);
    entry.window.set_min_inner_size(entry.min_size);
    entry.window.set_max_inner_size(entry.max_size);
}

/// Spelled out because `None` alone leaves the size type ambiguous.
const NO_LIMIT: Option<LogicalSize<f64>> = None;

/// macOS has no taskbar, so there is nothing to skip.
#[allow(clippy::needless_return)]
fn skip_taskbar(window: &tao::window::Window, skip: bool) -> ApiResult {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        #[cfg(target_os = "linux")]
        use tao::platform::unix::WindowExtUnix;
        #[cfg(target_os = "windows")]
        use tao::platform::windows::WindowExtWindows;

        return window
            .set_skip_taskbar(skip)
            .map(|_| Value::Null)
            .map_err(|e| ApiError::internal(format!("Could not change the taskbar: {e}")));
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (window, skip);
        Err(ApiError::unsupported(
            "macOS has no taskbar to skip. Hide the window instead, or use a tray icon.",
        ))
    }
}

pub fn dispatch(ctx: &mut MainCtx<'_>, method: &str, params: Value) -> ApiResult {
    ctx.rt
        .permissions
        .require(ctx.rt.permissions.window, method)?;

    // Calls about the set of windows rather than one window.
    match method {
        "window.create" => return create(ctx, params),
        "window.list" => return Ok(json!(ctx.windows.labels())),
        "window.current" => return Ok(json!(ctx.source)),
        "window.exists" => {
            let target: Target = serde_json::from_value(params).unwrap_or_default();
            let label = target.label.unwrap_or_else(|| ctx.source.to_string());
            return Ok(json!(ctx.windows.get(&label).is_some()));
        }
        "window.close" => return close(ctx, params),
        _ => {}
    }

    let label = target_label(ctx, &params);
    let entry = ctx.windows.require_mut(&label)?;
    let window = &entry.window;

    match method {
        "window.setTitle" => {
            let Title { title } = Request::params(method, params)?;
            window.set_title(&title);
            Ok(Value::Null)
        }
        "window.title" => Ok(json!(window.title())),

        "window.minimize" => {
            window.set_minimized(true);
            Ok(Value::Null)
        }
        "window.unminimize" => {
            window.set_minimized(false);
            Ok(Value::Null)
        }
        "window.maximize" => {
            set_maximized(entry, true);
            Ok(Value::Null)
        }
        "window.unmaximize" => {
            set_maximized(entry, false);
            Ok(Value::Null)
        }
        "window.toggleMaximize" => {
            let now = !entry.window.is_maximized();
            set_maximized(entry, now);
            Ok(json!(now))
        }
        "window.isMaximized" => Ok(json!(window.is_maximized())),

        "window.setSize" => {
            let Size { width, height } = Request::params(method, params)?;
            window.set_inner_size(LogicalSize::new(width, height));
            // Record it now so a `size()` immediately after `setSize()` is
            // right, rather than waiting for the resize event to catch up.
            entry.size = LogicalSize::new(width, height);
            Ok(Value::Null)
        }
        "window.size" => Ok(json!({ "width": entry.size.width, "height": entry.size.height })),

        // `null` for either dimension removes that limit.
        "window.setMinSize" => {
            let Limit { width, height } = Request::params(method, params)?;
            let limit = size_limit(width, height);
            entry.min_size = limit;
            if !entry.window.is_maximized() {
                entry.window.set_min_inner_size(limit);
            }
            Ok(Value::Null)
        }
        "window.setMaxSize" => {
            let Limit { width, height } = Request::params(method, params)?;
            let limit = size_limit(width, height);
            entry.max_size = limit;
            if !entry.window.is_maximized() {
                entry.window.set_max_inner_size(limit);
            }
            Ok(Value::Null)
        }

        "window.setSkipTaskbar" => {
            let Toggle { value } = Request::params(method, params)?;
            skip_taskbar(window, value)
        }

        "window.setPosition" => {
            let Position { x, y } = Request::params(method, params)?;
            window.set_outer_position(LogicalPosition::new(x, y));
            Ok(Value::Null)
        }
        "window.position" => {
            let position = window
                .outer_position()
                .map_err(|e| ApiError::unsupported(format!("Window position is unavailable: {e}")))?
                .to_logical::<f64>(window.scale_factor());
            Ok(json!({ "x": position.x, "y": position.y }))
        }

        "window.center" => {
            windows::center(window);
            Ok(Value::Null)
        }

        "window.setFullscreen" => {
            let Flag { value } = Request::params(method, params)?;
            window.set_fullscreen(value.then(|| Fullscreen::Borderless(None)));
            Ok(Value::Null)
        }
        "window.isFullscreen" => Ok(json!(window.fullscreen().is_some())),

        "window.setResizable" => {
            let Flag { value } = Request::params(method, params)?;
            window.set_resizable(value);
            Ok(Value::Null)
        }
        "window.setCloseBehavior" => {
            let Behaviour { behavior } = Request::params(method, params)?;
            entry.close_behavior = behavior;
            Ok(Value::Null)
        }
        "window.closeBehavior" => Ok(json!(match entry.close_behavior {
            CloseBehavior::Close => "close",
            CloseBehavior::Hide => "hide",
            CloseBehavior::Ask => "ask",
        })),

        "window.setAlwaysOnTop" => {
            let Flag { value } = Request::params(method, params)?;
            window.set_always_on_top(value);
            Ok(Value::Null)
        }

        "window.show" => {
            window.set_visible(true);
            Ok(Value::Null)
        }
        "window.hide" => {
            window.set_visible(false);
            Ok(Value::Null)
        }
        "window.isVisible" => Ok(json!(window.is_visible())),
        "window.focus" => {
            window.set_focus();
            Ok(Value::Null)
        }

        // A window with no title bar has nothing to drag it by, so the
        // application's own toolbar has to do it. `-webkit-app-region: drag`
        // is a Chromium extension and does nothing in a WKWebView, so this is
        // the portable way: call it from `pointerdown` and the platform takes
        // over the drag from there.
        "window.startDragging" => {
            window
                .drag_window()
                .map_err(|e| ApiError::unsupported(format!("Could not drag the window: {e}")))?;
            Ok(Value::Null)
        }

        // Switching between an ordinary title bar and one the application
        // draws in, on a window that is already open. Answers with the room
        // the new arrangement leaves, since that is what a caller needs next.
        "window.setTitleBarStyle" => {
            let Style { style } = Request::params(method, params)?;
            let label = entry.label.clone();
            let entry = ctx.windows.require_mut(&label)?;
            Ok(json!(entry.set_title_bar_style(style)))
        }
        // A taller bar than the platform's, with the lights re-centred in it.
        // `null` puts it back to whatever the platform uses.
        "window.setTitleBarHeight" => {
            let Height { height } = Request::params(method, params)?;
            let label = entry.label.clone();
            let entry = ctx.windows.require_mut(&label)?;
            Ok(json!(entry.set_title_bar_height(height)))
        }

        "window.titleBarStyle" => Ok(json!(match entry.title_bar_style {
            crate::config::TitleBarStyle::Hidden => "hidden",
            crate::config::TitleBarStyle::Default => "default",
        })),

        // Where the traffic lights sit, for a toolbar taller than the bar it
        // replaced. macOS only, because nowhere else has them.
        "window.setTrafficLightPosition" => {
            if cfg!(not(target_os = "macos")) {
                return Err(ApiError::unsupported(
                    "Only macOS has traffic lights to position",
                ));
            }
            let Position { x, y } = Request::params(method, params)?;
            let label = entry.label.clone();
            let entry = ctx.windows.require_mut(&label)?;
            Ok(json!(entry.set_traffic_lights(Some((x, y)))))
        }

        // Hand the window buttons to the application, or take them back.
        // Answers with the metrics, whose `insetLeft` is then zero - the same
        // signal the platforms without any already give.
        "window.setTitleBarButtons" => {
            let Buttons { buttons } = Request::params(method, params)?;
            let label = entry.label.clone();
            let entry = ctx.windows.require_mut(&label)?;
            Ok(json!(entry.set_buttons_hidden(
                buttons == crate::config::TitleBarButtons::Hidden
            )))
        }
        "window.titleBarButtons" => Ok(json!(if entry.buttons_hidden {
            "hidden"
        } else {
            "system"
        })),

        // Back to the middle of the bar, which is where they belong unless
        // an application has a reason otherwise.
        "window.centerTrafficLights" => {
            let label = entry.label.clone();
            let entry = ctx.windows.require_mut(&label)?;
            Ok(json!(entry.set_traffic_lights(None)))
        }

        "window.openDevtools" => {
            #[cfg(feature = "devtools")]
            {
                entry.webview.open_devtools();
                return Ok(Value::Null);
            }
            #[allow(unreachable_code)]
            Err(ApiError::unsupported(
                "Devtools are not available in this build",
            ))
        }

        _ => Err(ApiError::unknown_method(method)),
    }
}

/// The window a call is about: the one it names, or the one that made it.
fn target_label(ctx: &MainCtx<'_>, params: &Value) -> String {
    serde_json::from_value::<Target>(params.clone())
        .unwrap_or_default()
        .label
        .unwrap_or_else(|| ctx.source.to_string())
}

fn create(ctx: &mut MainCtx<'_>, params: Value) -> ApiResult {
    let params: CreateParams = Request::params("window.create", params)?;
    validate_label(&params.label)?;

    if ctx.windows.get(&params.label).is_some() {
        return Err(ApiError::new(
            crate::error::code::ALREADY_EXISTS,
            format!("A window labelled `{}` is already open", params.label),
        ));
    }

    let url = windows::resolve_url(ctx.rt, params.url.as_deref());
    let proxy = ctx.proxy();

    ctx.windows
        .create(
            ctx.target,
            ctx.rt,
            proxy,
            &params.label,
            &params.window,
            &url,
        )
        .map_err(ApiError::internal)?;

    // Windows hangs the application menu off each window.
    if let Some(entry) = ctx.windows.get(&params.label) {
        ctx.chrome.attach(&entry.window);
    }

    announce(ctx, "window.created", &params.label);
    Ok(json!(params.label))
}

fn close(ctx: &mut MainCtx<'_>, params: Value) -> ApiResult {
    let label = target_label(ctx, &params);
    if ctx.windows.get(&label).is_none() {
        // Closing an already-closed window is not an error worth raising.
        return Ok(json!(false));
    }

    ctx.windows.close(&label);
    announce(ctx, "window.closed", &label);

    if ctx.windows.is_empty() && ctx.rt.config.quit_on_last_window_closed {
        *ctx.exit = true;
    }
    Ok(json!(true))
}

/// Tell every remaining window that the set of windows changed.
fn announce(ctx: &MainCtx<'_>, event: &str, label: &str) {
    ctx.windows.deliver(
        None,
        &Outgoing::Event(Event::new(event, json!({ "label": label }))),
    );
}

/// Labels end up in URLs, logs and error messages, so keep them boring.
fn validate_label(label: &str) -> Result<(), ApiError> {
    if label.is_empty() || label.len() > 64 {
        return Err(ApiError::invalid_params(
            "A window label must be between 1 and 64 characters",
        ));
    }
    if !label
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ApiError::invalid_params(format!(
            "Invalid window label `{label}`: use letters, digits, `-` and `_`"
        )));
    }
    Ok(())
}

/// What the runtime does when a window's own close button is pressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Destroy the window.
    Destroy,
    /// Hide it and tell the application, so a tray app keeps running.
    Hide,
    /// Do nothing but tell the application, which now owns the decision.
    Ignore,
}

/// Decide what a close button means for a window.
///
/// A pure function so the rule can be tested; the event loop only carries it
/// out.
pub fn close_action(behavior: CloseBehavior) -> CloseAction {
    match behavior {
        CloseBehavior::Close => CloseAction::Destroy,
        CloseBehavior::Hide => CloseAction::Hide,
        CloseBehavior::Ask => CloseAction::Ignore,
    }
}

impl CloseAction {
    /// What `window.closeRequested` reports, or `None` when the window is
    /// about to be destroyed and there is nobody left to tell.
    pub fn outcome(self) -> Option<&'static str> {
        match self {
            CloseAction::Destroy => None,
            CloseAction::Hide => Some("hidden"),
            CloseAction::Ignore => Some("ignored"),
        }
    }
}

/// Used by the event loop when the user closes a window with its own controls.
pub fn closed_by_user(
    windows: &mut crate::windows::WindowManager,
    label: &str,
    quit_when_empty: bool,
) -> bool {
    windows.close(label);
    windows.deliver(
        None,
        &Outgoing::Event(Event::new("window.closed", json!({ "label": label }))),
    );
    windows.is_empty() && quit_when_empty
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_close_button_destroys_the_window_by_default() {
        assert_eq!(close_action(CloseBehavior::Close), CloseAction::Destroy);
        // Nothing to tell: the window is going away.
        assert_eq!(CloseAction::Destroy.outcome(), None);
    }

    #[test]
    fn hide_keeps_the_webview_alive_and_says_so() {
        // This is what lets a tray application survive its window closing:
        // the webview is still there, so timers keep firing and sockets stay
        // connected.
        assert_eq!(close_action(CloseBehavior::Hide), CloseAction::Hide);
        assert_eq!(CloseAction::Hide.outcome(), Some("hidden"));
    }

    #[test]
    fn ask_hands_the_decision_to_the_application() {
        assert_eq!(close_action(CloseBehavior::Ask), CloseAction::Ignore);
        assert_eq!(CloseAction::Ignore.outcome(), Some("ignored"));
    }

    #[test]
    fn window_labels_have_to_be_boring() {
        assert!(validate_label("settings").is_ok());
        assert!(validate_label("preview-2_x").is_ok());
        assert!(validate_label("").is_err());
        assert!(validate_label("not a label").is_err());
        assert!(validate_label("../escape").is_err());
        assert!(validate_label(&"x".repeat(65)).is_err());
    }
}
