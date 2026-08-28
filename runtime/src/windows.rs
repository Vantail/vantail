//! Windows and their webviews.
//!
//! Every window is identified by a **label** - a string the application
//! chooses, with `main` created at startup from the config. Labels are how
//! JavaScript names a window, how responses find their way back to the window
//! that made the call, and how events are addressed.
//!
//! Each webview gets its own IPC handler that stamps its label onto every
//! request, so the router always knows who is asking without JavaScript
//! having to say.

use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event_loop::{EventLoopProxy, EventLoopWindowTarget};
use tao::window::{Fullscreen, Window, WindowBuilder, WindowId};
use wry::{WebView, WebViewBuilder};

use std::sync::Arc;

use crate::chrome::titlebar;
use crate::config::{CloseBehavior, TitleBarStyle, WindowConfig};
use crate::error::ApiError;
use crate::ipc::{Outgoing, Request, UserEvent};
use crate::state::Runtime;
use crate::webview;

/// The window the runtime creates at startup.
pub const MAIN: &str = "main";

pub struct WindowEntry {
    pub label: String,
    /// Size limits the application asked for, remembered so they can be taken
    /// off while the window is maximised and put back afterwards. See
    /// `api::window::set_maximized`.
    pub min_size: Option<LogicalSize<f64>>,
    pub max_size: Option<LogicalSize<f64>>,
    /// What this window's close button does. Starts from the config and can
    /// be changed at runtime with `window.setCloseBehavior`.
    pub close_behavior: CloseBehavior,
    /// Whether this window currently has focus.
    ///
    /// Tracked from the events rather than queried, because the tray needs to
    /// tell "hidden" from "open but behind something" and those want
    /// different things to happen.
    pub focused: bool,
    /// Whether this window is currently drawing its own title bar, and what
    /// the config asked for in the first place.
    ///
    /// The original matters when switching back: an application that started
    /// with `decorations: false` should not gain a frame it never wanted just
    /// because it turned a hidden title bar off again.
    pub title_bar_style: TitleBarStyle,
    /// A height the application asked for, rather than the platform's.
    pub title_bar_height: Option<f64>,
    /// An explicit traffic light position, if the application set one.
    pub traffic_lights: Option<(f64, f64)>,
    /// What the platform's title bar measured before anything moved.
    pub native_title_bar: titlebar::Native,
    // Only the platforms that toggle the frame need this; macOS switches the
    // title bar without touching the decorations at all.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub decorations: bool,
    /// Current inner size in logical pixels.
    ///
    /// Tracked rather than queried: on macOS `Window::inner_size` keeps
    /// reporting the size the window was created with even after it has
    /// actually resized. The `Resized` events are correct, so the event loop
    /// keeps this in step and `window.size` answers from it.
    pub size: LogicalSize<f64>,
    // Declared before `window`: struct fields drop in declaration order, and
    // the webview holds a raw handle into the window it was built on.
    pub webview: WebView,
    pub window: Window,
}

impl WindowEntry {
    pub fn id(&self) -> WindowId {
        self.window.id()
    }

    /// Switch between an ordinary title bar and one the application draws in.
    ///
    /// The same three calls the builder makes, except after the fact - macOS
    /// lets all of them be changed on a live window. Everywhere else the only
    /// lever is the frame itself, so this is `set_decorations`, and switching
    /// back restores what the config asked for rather than assuming a frame.
    ///
    /// The page is told: the CSS variables and the bridge are updated in
    /// place, so a toolbar sized from them resizes with the change instead of
    /// keeping numbers that are no longer true.
    pub fn set_title_bar_style(&mut self, style: TitleBarStyle) -> titlebar::Metrics {
        let hidden = style == TitleBarStyle::Hidden;

        #[cfg(target_os = "macos")]
        {
            use objc2_app_kit::{NSWindow, NSWindowTitleVisibility};
            use tao::platform::macos::WindowExtMacOS;

            self.window.set_fullsize_content_view(hidden);
            self.window.set_titlebar_transparent(hidden);

            let pointer = self.window.ns_window() as *mut NSWindow;
            if !pointer.is_null() {
                // Safety: the pointer belongs to the window this entry owns,
                // and this runs on the event loop thread.
                let ns: &NSWindow = unsafe { &*pointer };
                ns.setTitleVisibility(if hidden {
                    NSWindowTitleVisibility::Hidden
                } else {
                    NSWindowTitleVisibility::Visible
                });
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            self.window
                .set_decorations(if hidden { false } else { self.decorations });
        }

        self.title_bar_style = style;
        self.remeasure()
    }

    /// Ask for a bar of a particular height, or `None` for the platform's own.
    ///
    /// Taller is the browser-toolbar case, and the traffic lights move to the
    /// middle of it - the part that is easy to get wrong by hand, and obvious
    /// the moment it is wrong.
    pub fn set_title_bar_height(&mut self, height: Option<f64>) -> titlebar::Metrics {
        self.title_bar_height = height;
        self.remeasure()
    }

    /// Place the traffic lights by hand, instead of centring them.
    pub fn set_traffic_lights(&mut self, position: Option<(f64, f64)>) -> titlebar::Metrics {
        self.traffic_lights = position;
        self.remeasure()
    }

    /// Measure again and tell the page, after anything that changes the sums.
    fn remeasure(&mut self) -> titlebar::Metrics {
        let metrics = match self.title_bar_style {
            TitleBarStyle::Hidden => titlebar::measure_with(
                &self.window,
                self.native_title_bar,
                self.title_bar_height,
                self.traffic_lights,
            ),
            TitleBarStyle::Default => titlebar::Metrics::none(),
        };
        self.publish_title_bar(metrics);
        metrics
    }

    /// Put the measured metrics back into the live page.
    fn publish_title_bar(&self, metrics: titlebar::Metrics) {
        let script = crate::webview::title_bar_script(metrics);
        if let Err(error) = self.webview.evaluate_script(&script) {
            eprintln!(
                "vantail: could not update the title bar metrics in `{}`: {error}",
                self.label
            );
        }
    }

    /// Push a response or event into this window.
    pub fn deliver(&self, outgoing: &Outgoing) {
        if let Err(error) = self.webview.evaluate_script(&outgoing.to_script()) {
            eprintln!("vantail: could not reach window `{}`: {error}", self.label);
        }
    }
}

#[derive(Default)]
pub struct WindowManager {
    /// A `Vec` rather than a map: applications have a handful of windows, and
    /// creation order is the order `window.list()` should report.
    entries: Vec<WindowEntry>,
}

impl WindowManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, label: &str) -> Option<&WindowEntry> {
        self.entries.iter().find(|entry| entry.label == label)
    }

    pub fn get_mut(&mut self, label: &str) -> Option<&mut WindowEntry> {
        self.entries.iter_mut().find(|entry| entry.label == label)
    }

    /// Look a window up, or explain which labels do exist.
    pub fn require(&self, label: &str) -> Result<&WindowEntry, ApiError> {
        self.get(label).ok_or_else(|| self.unknown(label))
    }

    pub fn require_mut(&mut self, label: &str) -> Result<&mut WindowEntry, ApiError> {
        if self.get(label).is_none() {
            return Err(self.unknown(label));
        }
        Ok(self.get_mut(label).expect("presence just checked"))
    }

    fn unknown(&self, label: &str) -> ApiError {
        ApiError::new(
            crate::error::code::NOT_FOUND,
            format!(
                "No window labelled `{label}`. Open windows: {}",
                self.labels().join(", ")
            ),
        )
    }

    pub fn by_id(&self, id: WindowId) -> Option<&WindowEntry> {
        self.entries.iter().find(|entry| entry.id() == id)
    }

    pub fn by_id_mut(&mut self, id: WindowId) -> Option<&mut WindowEntry> {
        self.entries.iter_mut().find(|entry| entry.id() == id)
    }

    pub fn labels(&self) -> Vec<String> {
        self.entries
            .iter()
            .map(|entry| entry.label.clone())
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn close(&mut self, label: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|entry| entry.label != label);
        self.entries.len() != before
    }

    /// Deliver to one window, or to all of them when `label` is `None`.
    pub fn deliver(&self, label: Option<&str>, outgoing: &Outgoing) {
        match label {
            Some(label) => {
                if let Some(entry) = self.get(label) {
                    entry.deliver(outgoing);
                }
            }
            None => {
                for entry in &self.entries {
                    entry.deliver(outgoing);
                }
            }
        }
    }

    /// Build a window and its webview, and take ownership of both.
    pub fn create(
        &mut self,
        target: &EventLoopWindowTarget<UserEvent>,
        rt: &Arc<Runtime>,
        proxy: EventLoopProxy<UserEvent>,
        label: &str,
        config: &WindowConfig,
        url: &str,
    ) -> Result<(), String> {
        if self.get(label).is_some() {
            return Err(format!("A window labelled `{label}` is already open"));
        }

        let window = build_window(rt, target, config)?;
        // Measured from the window that exists, not guessed from a constant -
        // and only when the application is the one drawing up there.
        // Measured before anything is moved, and kept: the numbers come off
        // the window buttons themselves.
        let native = titlebar::native(&window);
        let title_bar = match config.title_bar_style {
            TitleBarStyle::Hidden => titlebar::measure_with(
                &window,
                native,
                config.title_bar_height,
                config.traffic_light_position.map(|i| (i.x, i.y)),
            ),
            TitleBarStyle::Default => titlebar::Metrics::none(),
        };
        let webview = build_webview(rt, &window, proxy, label, url, title_bar)?;
        let size = window.inner_size().to_logical::<f64>(window.scale_factor());

        self.entries.push(WindowEntry {
            label: label.to_string(),
            min_size: None,
            max_size: None,
            close_behavior: config.close_behavior,
            title_bar_style: config.title_bar_style,
            title_bar_height: config.title_bar_height,
            traffic_lights: config.traffic_light_position.map(|i| (i.x, i.y)),
            native_title_bar: native,
            decorations: config.decorations,
            focused: false,
            size,
            webview,
            window,
        });
        Ok(())
    }
}

/// The URL a window should load: the dev server in development, the custom
/// protocol otherwise. `path` is relative to the application root.
pub fn resolve_url(rt: &Runtime, path: Option<&str>) -> String {
    let path = path.unwrap_or("index.html").trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match &rt.config.dev {
        Some(dev) => format!("{}{path}", ensure_trailing_slash(&dev.url)),
        None => webview::app_url(path),
    }
}

fn ensure_trailing_slash(url: &str) -> String {
    if url.ends_with('/') {
        url.to_string()
    } else {
        format!("{url}/")
    }
}

fn build_window(
    rt: &Runtime,
    target: &EventLoopWindowTarget<UserEvent>,
    config: &WindowConfig,
) -> Result<Window, String> {
    let title = config
        .title
        .clone()
        .unwrap_or_else(|| rt.config.app.name.clone());

    // A hidden title bar has no bar to decorate. On macOS the decorations
    // stay on - that is what keeps the traffic lights, and the bar itself is
    // removed by the platform-specific calls below. Everywhere else the only
    // way to lose the bar is to lose the frame with it.
    let hidden = config.title_bar_style == TitleBarStyle::Hidden;
    let decorations = if hidden && !cfg!(target_os = "macos") {
        false
    } else {
        config.decorations
    };

    let mut builder = WindowBuilder::new()
        .with_title(title)
        .with_inner_size(LogicalSize::new(config.width, config.height))
        .with_resizable(config.resizable)
        .with_maximized(config.maximized)
        .with_decorations(decorations)
        .with_transparent(config.transparent)
        .with_always_on_top(config.always_on_top)
        // Shown once the webview exists, so the first frame is the
        // application rather than a white rectangle.
        .with_visible(false);

    if let (Some(width), Some(height)) = (config.min_width, config.min_height) {
        builder = builder.with_min_inner_size(LogicalSize::new(width, height));
    }
    if let (Some(width), Some(height)) = (config.max_width, config.max_height) {
        builder = builder.with_max_inner_size(LogicalSize::new(width, height));
    }
    if let (Some(x), Some(y)) = (config.x, config.y) {
        builder = builder.with_position(LogicalPosition::new(x, y));
    }
    if config.fullscreen {
        builder = builder.with_fullscreen(Some(Fullscreen::Borderless(None)));
    }

    #[cfg(target_os = "macos")]
    if hidden {
        use tao::platform::macos::WindowBuilderExtMacOS;

        // The three together are what "no bar, but keep the buttons" means:
        // the content view runs the full height of the window, the bar itself
        // is transparent, and the title text is gone.
        builder = builder
            .with_fullsize_content_view(true)
            .with_titlebar_transparent(true)
            .with_title_hidden(true);

        // A toolbar taller than the bar it replaced usually wants the lights
        // moved down to sit in the middle of it.
        if let Some(inset) = config.traffic_light_position {
            builder = builder.with_traffic_light_inset(LogicalPosition::new(inset.x, inset.y));
        }
    }

    if let Some(icon) = window_icon(rt) {
        builder = builder.with_window_icon(Some(icon));
    }

    let window = builder
        .build(target)
        .map_err(|e| format!("Could not open a window: {e}"))?;

    // An explicit position wins over centring.
    if config.center && config.x.is_none() && config.y.is_none() {
        center(&window);
    }
    if config.visible {
        window.set_visible(true);
    }

    Ok(window)
}

/// The window and taskbar icon.
///
/// macOS reads its icon from the application bundle, so this does nothing
/// there - but a Windows or Linux window without one gets a blank square.
fn window_icon(rt: &Runtime) -> Option<tao::window::Icon> {
    let path = rt.config.app.icon.as_ref()?;
    let resolved = if std::path::Path::new(path).is_absolute() {
        std::path::PathBuf::from(path)
    } else {
        rt.resource_dir.join(path)
    };

    match crate::chrome::icon::load_png(&resolved) {
        Ok(image) => tao::window::Icon::from_rgba(image.bytes, image.width, image.height).ok(),
        Err(error) => {
            // A missing icon is cosmetic; refusing to open the window is not.
            eprintln!("vantail: could not load the window icon: {}", error.message);
            None
        }
    }
}

pub fn center(window: &Window) {
    let Some(monitor) = window.current_monitor() else {
        return;
    };
    let scale = window.scale_factor();
    let screen = monitor.size().to_logical::<f64>(scale);
    let origin = monitor.position().to_logical::<f64>(scale);
    let size = window.outer_size().to_logical::<f64>(scale);

    window.set_outer_position(LogicalPosition::new(
        origin.x + (screen.width - size.width) / 2.0,
        origin.y + (screen.height - size.height) / 2.0,
    ));
}

fn build_webview(
    rt: &Arc<Runtime>,
    window: &Window,
    proxy: EventLoopProxy<UserEvent>,
    label: &str,
    url: &str,
    title_bar: crate::chrome::titlebar::Metrics,
) -> Result<WebView, String> {
    let resources = webview::Resources::new(&rt.resource_dir);
    let devtools = rt.config.devtools.unwrap_or_else(|| rt.is_dev());
    let source = label.to_string();
    let loaded_label = label.to_string();
    let load_proxy = proxy.clone();

    let builder = WebViewBuilder::new()
        .with_initialization_script(webview::init_script(rt, label, title_bar))
        .with_devtools(devtools)
        // A desktop app's background window is not a browser tab that nobody
        // is looking at: it may be doing work on purpose, and a window that
        // opens unfocused still has to finish loading. Left at the default,
        // a window created while the app is not frontmost can sit suspended.
        .with_background_throttling(wry::BackgroundThrottlingPolicy::Disabled)
        .with_transparent(rt.config.window.transparent)
        .with_custom_protocol(webview::SCHEME.to_string(), move |_id, request| {
            resources.serve(&request)
        })
        .with_drag_drop_handler({
            let rt = Arc::clone(rt);
            let label = label.to_string();
            move |event| drag_drop(&rt, &label, event)
        })
        .with_ipc_handler(move |request: wry::http::Request<String>| {
            let body = request.into_body();
            // The label is stamped on here rather than sent by JavaScript, so
            // a window cannot claim to be a different one.
            let message = match serde_json::from_str::<Request>(&body) {
                Ok(request) => UserEvent::Request {
                    window: source.clone(),
                    request,
                },
                Err(error) => UserEvent::Outgoing {
                    window: Some(source.clone()),
                    outgoing: crate::ipc::malformed(format!(
                        "Could not parse an IPC message: {error}"
                    )),
                },
            };
            // A closed event loop means we are shutting down; the message has
            // nowhere useful to go.
            let _ = proxy.send_event(message);
        })
        .with_on_page_load_handler(move |event, _url| {
            // A window exists before its page does. Announcing readiness is
            // what lets `createWindow` resolve at a point where the new window
            // can actually receive a message.
            if matches!(event, wry::PageLoadEvent::Finished) {
                let _ = load_proxy.send_event(UserEvent::Outgoing {
                    window: None,
                    outgoing: Outgoing::Event(crate::ipc::Event::new(
                        "window.ready",
                        serde_json::json!({ "label": loaded_label }),
                    )),
                });
            }
        })
        .with_url(url);

    attach(builder, window)
}

/// Put the webview inside the window.
///
/// Everywhere else this takes the window itself. On Linux it has to be the
/// GTK container tao puts inside it: building from the window uses the X11
/// handle, which does not exist under Wayland - where it fails with "the
/// underlying handle is not available" and no window ever appears.
#[cfg(not(target_os = "linux"))]
fn attach(builder: WebViewBuilder<'_>, window: &Window) -> Result<WebView, String> {
    builder
        .build(window)
        .map_err(|e| format!("Could not create the webview: {e}"))
}

#[cfg(target_os = "linux")]
fn attach(builder: WebViewBuilder<'_>, window: &Window) -> Result<WebView, String> {
    use tao::platform::unix::WindowExtUnix;
    use wry::WebViewBuilderExtUnix;

    // tao puts a vertical box in every window it makes; this is that box.
    let container = window
        .default_vbox()
        .ok_or("The window has no GTK container to put a webview in")?;

    builder
        .build_gtk(container)
        .map_err(|e| format!("Could not create the webview: {e}"))
}

/// Report a drag onto a window, and make what it carries openable.
///
/// Returning `true` means the runtime handled it and the page never sees the
/// drop; returning `false` lets WebKit do what it always did, which is deliver
/// HTML5 drag events carrying file *contents* but no paths. So an application
/// that has not asked for `dragDrop` keeps exactly the behaviour it had.
fn drag_drop(rt: &Arc<Runtime>, label: &str, event: wry::DragDropEvent) -> bool {
    if !rt.permissions.drag_drop {
        return false;
    }

    let (name, payload) = match event {
        wry::DragDropEvent::Enter { paths, position } => (
            "drop.entered",
            serde_json::json!({
                "paths": paths.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
                "position": { "x": position.0, "y": position.1 },
            }),
        ),

        wry::DragDropEvent::Drop { paths, position } => {
            // The paths are useless unless they can be opened, and dropping a
            // file is the user choosing it exactly as a dialog is.
            for path in &paths {
                rt.permissions.grant_from_drop(path);
            }
            (
                "drop.dropped",
                serde_json::json!({
                    "paths": paths.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
                    "position": { "x": position.0, "y": position.1 },
                }),
            )
        }

        wry::DragDropEvent::Leave => ("drop.left", serde_json::json!({})),

        // Fires continuously while the pointer moves. A page that wants hover
        // feedback has CSS and its own dragover for it.
        _ => return true,
    };

    rt.send(
        Some(label.to_string()),
        Outgoing::Event(crate::ipc::Event::new(name, payload)),
    );
    true
}
