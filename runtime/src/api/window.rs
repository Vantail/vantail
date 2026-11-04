//! `window.*` - the application's windows.
//!
//! Every method acts on the window that called it unless the call names a
//! different one with `label`. That keeps the common case - an app with one
//! window, or a window adjusting itself - free of ceremony, while still
//! letting any window drive any other.

use serde::Deserialize;
use serde_json::{json, Value};
use tao::dpi::{LogicalPosition, LogicalSize};
use tao::window::{Fullscreen, Window};

use crate::config::{CloseBehavior, WindowConfig};
use crate::error::{ApiError, ApiResult};
use crate::ipc::{Event, Outgoing, Request};
use crate::state::MainCtx;
use crate::windows::{self, WindowEntry};

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

/// Where to put the window buttons: across always, down only if asked.
///
/// `y` is optional because moving the group sideways is the common wish, and
/// having to restate the vertical centre to do it means restating it again
/// whenever the bar's height changes.
#[derive(Deserialize)]
struct Nudge {
    x: f64,
    #[serde(default)]
    y: Option<f64>,
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

/// Maximise or restore without AppKit's zoom animation.
///
/// `zoom:` animates the frame over about 200ms, and a web view lays out
/// asynchronously in another process - so for the whole animation the page is
/// still drawn at the size it was, and the window appears to drag its contents
/// behind it. Setting the frame in one step gives WebKit a single layout to do
/// instead of a moving target.
///
/// `false` means this did not handle it and the caller should fall back: no
/// screen to measure, or a restore with nothing remembered to restore to.
fn zoom_in_one_step(entry: &mut WindowEntry, maximized: bool) -> bool {
    // Asked for the platform animation, so there is nothing to avoid.
    if entry.animate_zoom {
        return false;
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Only macOS animates a zoom. Both fields are still read here, because
        // one that is only ever read inside a `cfg` is dead code everywhere
        // that compiles the block out.
        let _ = (maximized, entry.restore_frame);
        false
    }

    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWindow;
        use objc2_foundation::{NSPoint, NSRect, NSSize};
        use tao::platform::macos::WindowExtMacOS;

        let ns_window = entry.window.ns_window() as *mut NSWindow;
        if ns_window.is_null() {
            return false;
        }

        // Safety: the pointer was checked for null above and belongs to the
        // window this entry owns, which outlives the call. Window methods are
        // dispatched on the event loop's thread, the main one.
        unsafe {
            let ns_window = &*ns_window;

            let frame = if maximized {
                let Some(screen) = ns_window.screen() else {
                    return false;
                };
                let here = ns_window.frame();
                entry.restore_frame = Some((
                    here.origin.x,
                    here.origin.y,
                    here.size.width,
                    here.size.height,
                ));
                screen.visibleFrame()
            } else {
                // Nothing remembered - the window was maximised by the platform,
                // or at startup - so let AppKit do what it knows.
                let Some((x, y, width, height)) = entry.restore_frame.take() else {
                    return false;
                };
                NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
            };

            ns_window.setFrame_display_animate(frame, true, false);
        }

        true
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
fn set_maximized(entry: &mut WindowEntry, maximized: bool) -> ApiResult {
    if maximized {
        entry.window.set_min_inner_size(NO_LIMIT);
        entry.window.set_max_inner_size(NO_LIMIT);
    }

    // `animateZoom` keeps the platform animation, and the lag with it.
    let snapped = zoom_in_one_step(entry, maximized);

    if !snapped {
        entry.window.set_maximized(maximized);
    }

    if !maximized {
        entry.window.set_min_inner_size(entry.min_size);
        entry.window.set_max_inner_size(entry.max_size);
    }
    Ok(Value::Null)
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

        window
            .set_skip_taskbar(skip)
            .map_err(|e| ApiError::internal(format!("Could not change the taskbar: {e}")))?;
        return Ok(Value::Null);
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
        "window.exists" => return exists(ctx, params),
        "window.close" => return close(ctx, params),
        _ => {}
    }

    let label = target_label(ctx, &params);

    // The menu bar lives in the title bar's frame on Windows, so changing the
    // style reaches past the one window.
    if method == "window.setTitleBarStyle" {
        return set_title_bar_style(ctx, &label, params);
    }

    let entry = ctx.windows.require_mut(&label)?;
    one_window(entry, method, params)
}

/// The calls that act on one window and nothing else.
fn one_window(entry: &mut WindowEntry, method: &str, params: Value) -> ApiResult {
    let window = &entry.window;
    match method {
        "window.setTitle" => set_title(window, params),
        "window.title" => Ok(json!(window.title())),

        "window.minimize" => set_minimized(window, true),
        "window.unminimize" => set_minimized(window, false),
        "window.maximize" => set_maximized(entry, true),
        "window.unmaximize" => set_maximized(entry, false),
        "window.toggleMaximize" => toggle_maximized(entry),
        "window.isMaximized" => Ok(json!(window.is_maximized())),

        "window.setSize" => set_size(entry, params),
        "window.size" => Ok(json!({ "width": entry.size.width, "height": entry.size.height })),
        "window.setMinSize" => set_min_size(entry, params),
        "window.setMaxSize" => set_max_size(entry, params),
        "window.setSkipTaskbar" => set_skip_taskbar(window, params),
        "window.setPosition" => set_position(window, params),
        "window.position" => position(window),
        "window.center" => center(window),

        "window.setFullscreen" => set_fullscreen(window, params),
        "window.isFullscreen" => Ok(json!(window.fullscreen().is_some())),
        "window.setResizable" => set_resizable(window, params),
        "window.setCloseBehavior" => set_close_behavior(entry, params),
        "window.closeBehavior" => Ok(json!(close_behavior_name(entry.close_behavior))),
        "window.setAlwaysOnTop" => set_always_on_top(window, params),

        "window.show" => set_visible(window, true),
        "window.hide" => set_visible(window, false),
        "window.isVisible" => Ok(json!(window.is_visible())),
        "window.focus" => focus(window),
        "window.startDragging" => start_dragging(window),

        "window.setTitleBarHeight" => set_title_bar_height(entry, params),
        "window.titleBarStyle" => Ok(json!(title_bar_style_name(entry.title_bar_style))),
        "window.setTrafficLightPosition" => set_traffic_light_position(entry, params),
        "window.centerTrafficLights" => Ok(json!(entry.set_traffic_lights(None))),
        "window.setTitleBarButtons" => set_title_bar_buttons(entry, params),
        "window.titleBarButtons" => Ok(json!(title_bar_buttons_name(entry.buttons_hidden))),

        "window.openDevtools" => open_devtools(entry),

        _ => Err(ApiError::unknown_method(method)),
    }
}

fn exists(ctx: &MainCtx<'_>, params: Value) -> ApiResult {
    let label = target_label(ctx, &params);
    Ok(json!(ctx.windows.get(&label).is_some()))
}

fn set_title(window: &Window, params: Value) -> ApiResult {
    let Title { title } = Request::params("window.setTitle", params)?;
    window.set_title(&title);
    Ok(Value::Null)
}

fn set_minimized(window: &Window, minimized: bool) -> ApiResult {
    window.set_minimized(minimized);
    Ok(Value::Null)
}

/// Answers with whether the window is now maximised.
fn toggle_maximized(entry: &mut WindowEntry) -> ApiResult {
    let now = !entry.window.is_maximized();
    set_maximized(entry, now)?;
    Ok(json!(now))
}

fn set_size(entry: &mut WindowEntry, params: Value) -> ApiResult {
    let Size { width, height } = Request::params("window.setSize", params)?;
    entry.window.set_inner_size(LogicalSize::new(width, height));
    // Record it now so a `size()` immediately after `setSize()` is right,
    // rather than waiting for the resize event to catch up.
    entry.size = LogicalSize::new(width, height);
    Ok(Value::Null)
}

/// `null` for either dimension removes the limit.
fn set_min_size(entry: &mut WindowEntry, params: Value) -> ApiResult {
    let Limit { width, height } = Request::params("window.setMinSize", params)?;
    let limit = size_limit(width, height);
    entry.min_size = limit;
    if !entry.window.is_maximized() {
        entry.window.set_min_inner_size(limit);
    }
    Ok(Value::Null)
}

/// `null` for either dimension removes the limit.
fn set_max_size(entry: &mut WindowEntry, params: Value) -> ApiResult {
    let Limit { width, height } = Request::params("window.setMaxSize", params)?;
    let limit = size_limit(width, height);
    entry.max_size = limit;
    if !entry.window.is_maximized() {
        entry.window.set_max_inner_size(limit);
    }
    Ok(Value::Null)
}

fn set_skip_taskbar(window: &Window, params: Value) -> ApiResult {
    let Toggle { value } = Request::params("window.setSkipTaskbar", params)?;
    skip_taskbar(window, value)
}

fn set_position(window: &Window, params: Value) -> ApiResult {
    let Position { x, y } = Request::params("window.setPosition", params)?;
    window.set_outer_position(LogicalPosition::new(x, y));
    Ok(Value::Null)
}

fn position(window: &Window) -> ApiResult {
    let position = window
        .outer_position()
        .map_err(|e| ApiError::unsupported(format!("Window position is unavailable: {e}")))?
        .to_logical::<f64>(window.scale_factor());
    Ok(json!({ "x": position.x, "y": position.y }))
}

fn center(window: &Window) -> ApiResult {
    windows::center(window);
    Ok(Value::Null)
}

fn set_fullscreen(window: &Window, params: Value) -> ApiResult {
    let Flag { value } = Request::params("window.setFullscreen", params)?;
    let mode = if value {
        Some(Fullscreen::Borderless(None))
    } else {
        None
    };
    window.set_fullscreen(mode);
    Ok(Value::Null)
}

fn set_resizable(window: &Window, params: Value) -> ApiResult {
    let Flag { value } = Request::params("window.setResizable", params)?;
    window.set_resizable(value);
    Ok(Value::Null)
}

fn set_close_behavior(entry: &mut WindowEntry, params: Value) -> ApiResult {
    let Behaviour { behavior } = Request::params("window.setCloseBehavior", params)?;
    entry.close_behavior = behavior;
    Ok(Value::Null)
}

fn close_behavior_name(behavior: CloseBehavior) -> &'static str {
    match behavior {
        CloseBehavior::Close => "close",
        CloseBehavior::Hide => "hide",
        CloseBehavior::Ask => "ask",
    }
}

fn set_always_on_top(window: &Window, params: Value) -> ApiResult {
    let Flag { value } = Request::params("window.setAlwaysOnTop", params)?;
    window.set_always_on_top(value);
    Ok(Value::Null)
}

fn set_visible(window: &Window, visible: bool) -> ApiResult {
    window.set_visible(visible);
    Ok(Value::Null)
}

fn focus(window: &Window) -> ApiResult {
    window.set_focus();
    Ok(Value::Null)
}

/// A window with no title bar has nothing to drag it by, so the application's
/// own toolbar has to do it. `-webkit-app-region: drag` is a Chromium
/// extension and does nothing in a WKWebView, so this is the portable way:
/// call it from `pointerdown` and the platform takes over the drag from there.
fn start_dragging(window: &Window) -> ApiResult {
    window
        .drag_window()
        .map_err(|e| ApiError::unsupported(format!("Could not drag the window: {e}")))?;
    Ok(Value::Null)
}

/// Switch between an ordinary title bar and one the application draws in, on
/// a window that is already open. Answers with the room the new arrangement
/// leaves, since that is what a caller needs next.
fn set_title_bar_style(ctx: &mut MainCtx<'_>, label: &str, params: Value) -> ApiResult {
    let Style { style } = Request::params("window.setTitleBarStyle", params)?;
    let entry = ctx.windows.require_mut(label)?;
    // What the page has now. On Windows this call adds or removes the
    // window's frame, and the frame - with the menu bar in it - comes out of
    // the window rather than out of the page: without this the page would
    // gain a title bar's worth of room for hiding one, and a different amount
    // back for showing it again.
    #[cfg(target_os = "windows")]
    let before = if entry.window.is_maximized() {
        None
    } else {
        Some(entry.window.inner_size())
    };

    let metrics = entry.set_title_bar_style(style);

    // The menu bar lives in the frame, so a window that has just lost one has
    // to lose the menu with it, and one that has just got it back wants the
    // menu back too.
    ctx.chrome.attach(&entry.window);

    #[cfg(target_os = "windows")]
    if let Some(size) = before {
        entry.window.set_inner_size(size);
    }

    Ok(json!(metrics))
}

/// A taller bar than the platform's, with the lights re-centred in it.
/// `null` puts it back to whatever the platform uses.
fn set_title_bar_height(entry: &mut WindowEntry, params: Value) -> ApiResult {
    let Height { height } = Request::params("window.setTitleBarHeight", params)?;
    Ok(json!(entry.set_title_bar_height(height)))
}

fn title_bar_style_name(style: crate::config::TitleBarStyle) -> &'static str {
    match style {
        crate::config::TitleBarStyle::Hidden => "hidden",
        crate::config::TitleBarStyle::Default => "default",
    }
}

/// Where the traffic lights sit, for a toolbar taller than the bar it
/// replaced. macOS only, because nowhere else has them. Moving them back to
/// the middle of the bar is `window.centerTrafficLights`.
fn set_traffic_light_position(entry: &mut WindowEntry, params: Value) -> ApiResult {
    if cfg!(not(target_os = "macos")) {
        return Err(ApiError::unsupported(
            "Only macOS has traffic lights to position",
        ));
    }
    let Nudge { x, y } = Request::params("window.setTrafficLightPosition", params)?;
    Ok(json!(entry.set_traffic_lights(Some((x, y)))))
}

/// Hand the window buttons to the application, or take them back. Answers
/// with the metrics, whose `insetLeft` is then zero - the same signal the
/// platforms without any already give.
fn set_title_bar_buttons(entry: &mut WindowEntry, params: Value) -> ApiResult {
    let Buttons { buttons } = Request::params("window.setTitleBarButtons", params)?;
    let hidden = buttons == crate::config::TitleBarButtons::Hidden;
    Ok(json!(entry.set_buttons_hidden(hidden)))
}

fn title_bar_buttons_name(hidden: bool) -> &'static str {
    if hidden {
        "hidden"
    } else {
        "system"
    }
}

fn open_devtools(entry: &WindowEntry) -> ApiResult {
    #[cfg(feature = "devtools")]
    {
        entry.webview.open_devtools();
        Ok(Value::Null)
    }

    #[cfg(not(feature = "devtools"))]
    {
        let _ = entry;
        Err(ApiError::unsupported(
            "Devtools are not available in this build",
        ))
    }
}

/// The window a call is about: the one it names, or the one that made it.
fn target_label(ctx: &MainCtx<'_>, params: &Value) -> String {
    let named = match serde_json::from_value::<Target>(params.clone()) {
        Ok(target) => target.label,
        Err(_) => None,
    };
    match named {
        Some(label) => label,
        None => ctx.source.to_string(),
    }
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

    ctx.windows
        .create(ctx.target, ctx.rt, &params.label, &params.window, &url)
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

/// Letters, digits, `-` and `_`, and nothing else.
fn is_label(text: &str) -> bool {
    for character in text.chars() {
        let allowed = character.is_ascii_alphanumeric() || character == '-' || character == '_';
        if !allowed {
            return false;
        }
    }
    true
}

/// Labels end up in URLs, logs and error messages, so keep them boring.
fn validate_label(label: &str) -> Result<(), ApiError> {
    if label.is_empty() || label.len() > 64 {
        return Err(ApiError::invalid_params(
            "A window label must be between 1 and 64 characters",
        ));
    }
    if !is_label(label) {
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
