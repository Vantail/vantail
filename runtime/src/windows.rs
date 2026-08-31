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
use crate::config::{CloseBehavior, TitleBarButtons, TitleBarStyle, WindowConfig};
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
    pub traffic_lights: Option<(f64, Option<f64>)>,
    /// Whether the platform's own window buttons are hidden, so the
    /// application can draw its own.
    pub buttons_hidden: bool,
    /// What the title bar in force measures, before anything moved. Re-taken
    /// when the bar changes shape, because a taller one puts the window
    /// buttons somewhere else.
    pub native_title_bar: titlebar::Native,
    /// What the platform's own title bar measured, taken once before anything
    /// grew it or moved anything in it. Both the height to fall back to and
    /// the position to put the window buttons back to - neither can be read
    /// off a window that has already been changed, which is how "put them
    /// back" quietly stopped putting them back.
    pub platform_bar: titlebar::Native,
    /// The shape the title bar should keep, read by the watcher below whenever
    /// AppKit lays the window out again.
    pub title_bar_shape: titlebar::Keeper,
    /// Puts the bar's height back from inside AppKit's own layout, which is
    /// the only place it is not already too late. Dropped with the window.
    #[allow(dead_code)]
    pub title_bar_watch: titlebar::Watch,
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
    /// Animate maximise and restore, rather than snapping. macOS only.
    pub animate_zoom: bool,

    /// The corner radii, kept because a shape mask has to be rebuilt from the
    /// new bounds every time the window changes size.
    pub corner_radii: Option<crate::config::Radii>,

    /// Where the window was before it was maximised, so a snap can put it
    /// back. AppKit keeps its own copy for an animated zoom; this is the one
    /// for when we set the frame ourselves.
    pub restore_frame: Option<(f64, f64, f64, f64)>,

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

    /// Hand the window buttons over to the application, or take them back.
    ///
    /// Hiding them zeroes `insetLeft`, which is the same signal the platforms
    /// without any already give - so a page that draws its own controls when
    /// nothing is reserved needs no new branch for this.
    pub fn set_buttons_hidden(&mut self, hidden: bool) -> titlebar::Metrics {
        self.buttons_hidden = hidden;
        titlebar::set_buttons_hidden(&self.window, hidden);
        self.remeasure()
    }

    /// Place the traffic lights by hand, instead of centring them.
    pub fn set_traffic_lights(
        &mut self,
        position: Option<(f64, Option<f64>)>,
    ) -> titlebar::Metrics {
        self.traffic_lights = position;
        self.remeasure()
    }

    /// Put the window buttons back where they were asked to be.
    ///
    /// AppKit re-lays the title bar out whenever the window resizes, which
    /// undoes any frame that was set - so a window whose lights were moved
    /// loses them the moment the user drags a corner, and gets them back only
    /// on the next call that happened to remeasure. Nothing about the metrics
    /// changes with the width, so this places them again and leaves the page
    /// alone.
    /// Rebuild the corner shape for the window's new size.
    ///
    /// Only needed for four different radii: one radius is a `cornerRadius`,
    /// which follows the layer on its own.
    pub fn reshape_corners(&self) {
        let Some(radii) = self.corner_radii else {
            return;
        };
        if radii.uniform().is_some() {
            return;
        }
        round_corners(&self.webview, Some(radii), None);
    }

    pub fn reapply_title_bar(&mut self) {
        if self.title_bar_style != TitleBarStyle::Hidden {
            return;
        }
        self.refit();
    }

    /// Put the platform's bar into the shape the request asks for.
    ///
    /// A height greater than the ordinary bar's is a request macOS can answer
    /// itself, and its answer is worth having: it centres the window buttons
    /// in the taller bar and keeps them there while the window is resized,
    /// which moving them cannot do. The measurement is retaken because the
    /// buttons are somewhere else afterwards.
    /// Shape the title bar to the height in force, and measure what resulted.
    ///
    /// Only while the platform is still drawing the buttons. With them hidden
    /// there is no container worth growing - the application draws the bar and
    /// everything in it - and the height it asked for is simply the answer.
    fn refit(&mut self) -> f64 {
        let wanted = if self.title_bar_style == TitleBarStyle::Hidden && !self.buttons_hidden {
            self.title_bar_height
        } else {
            None
        };
        let height = titlebar::fit(
            &self.window,
            wanted,
            self.platform_bar,
            self.traffic_lights,
            &self.title_bar_shape,
        );
        self.native_title_bar = titlebar::native(&self.window);
        height
    }

    /// Measure again and tell the page, after anything that changes the sums.
    fn remeasure(&mut self) -> titlebar::Metrics {
        let height = self.refit();
        let metrics = match self.title_bar_style {
            TitleBarStyle::Hidden => {
                titlebar::metrics_for(self.native_title_bar, height, !self.buttons_hidden)
            }
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
        let buttons_hidden = config.title_bar_buttons == TitleBarButtons::Hidden;
        // Taken before anything grows the bar: it cannot be measured back off
        // a window whose title bar has already been made taller.
        let platform_bar = titlebar::native(&window);
        // Registered before the first shaping, so nothing AppKit does to the
        // bar between now and the window closing goes uncorrected.
        let title_bar_shape = titlebar::Keeper::default();
        let title_bar_watch = titlebar::keep(&window, &title_bar_shape);
        let height = titlebar::fit(
            &window,
            if config.title_bar_style == TitleBarStyle::Hidden && !buttons_hidden {
                config.title_bar_height
            } else {
                None
            },
            platform_bar,
            config.traffic_light_position.map(|i| (i.x, i.y)),
            &title_bar_shape,
        );
        let native = titlebar::native(&window);
        let title_bar = match config.title_bar_style {
            TitleBarStyle::Hidden => titlebar::metrics_for(native, height, !buttons_hidden),
            TitleBarStyle::Default => titlebar::Metrics::none(),
        };
        let webview = build_webview(
            rt,
            &window,
            proxy,
            label,
            url,
            Presentation {
                title_bar,
                background: config
                    .background_color
                    .as_deref()
                    .and_then(crate::config::parse_color),
                scroll: config.scroll,
                // A framed window already has the platform's corners; rounding
                // the content inside them leaves a notch where the two shapes
                // disagree, so the setting only applies without a frame.
                corners: config
                    .border_radius
                    .filter(|_| !has_decorations(config))
                    .and_then(crate::config::BorderRadius::radii),
            },
        )?;
        // Again, now the webview is attached. Putting the content view in
        // makes AppKit lay the title bar out, which undoes the placement above
        // - and nothing after that undoes it again, so this is the one that
        // holds. Electron builds its buttons proxy at the same point.
        titlebar::fit(
            &window,
            if config.title_bar_style == TitleBarStyle::Hidden && !buttons_hidden {
                config.title_bar_height
            } else {
                None
            },
            platform_bar,
            config.traffic_light_position.map(|i| (i.x, i.y)),
            &title_bar_shape,
        );
        let size = window.inner_size().to_logical::<f64>(window.scale_factor());

        self.entries.push(WindowEntry {
            label: label.to_string(),
            min_size: None,
            max_size: None,
            close_behavior: config.close_behavior,
            title_bar_style: config.title_bar_style,
            title_bar_height: config.title_bar_height,
            traffic_lights: config.traffic_light_position.map(|i| (i.x, i.y)),
            buttons_hidden: config.title_bar_buttons == TitleBarButtons::Hidden,
            native_title_bar: native,
            platform_bar,
            title_bar_shape,
            title_bar_watch,
            decorations: config.decorations,
            animate_zoom: config.animate_zoom,
            corner_radii: config
                .border_radius
                .filter(|_| !has_decorations(config))
                .and_then(crate::config::BorderRadius::radii),
            restore_frame: None,
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

    let decorations = has_decorations(config);

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
    if config.title_bar_style == TitleBarStyle::Hidden {
        use tao::platform::macos::WindowBuilderExtMacOS;

        // The three together are what "no bar, but keep the buttons" means:
        // the content view runs the full height of the window, the bar itself
        // is transparent, and the title text is gone.
        builder = builder
            .with_titlebar_buttons_hidden(config.title_bar_buttons == TitleBarButtons::Hidden)
            .with_fullsize_content_view(true)
            .with_titlebar_transparent(true)
            .with_title_hidden(true);

        // Deliberately not `with_traffic_light_inset`. tao has its own version
        // of this and re-applies it from the content view's `drawRect:` - a
        // hook that never fires here, because the content view is the web
        // view. Leaving it set would put a second actor on the same three
        // buttons for no benefit; `chrome::titlebar` owns them.
    }

    if let Some(icon) = window_icon(rt) {
        builder = builder.with_window_icon(Some(icon));
    }

    // The window's own background, which is what shows while the web view is
    // still catching up with a resize - the page has not painted that strip
    // yet, so the colour under it is the one on screen. wry paints the *view*;
    // this is the window beneath it, and both want the same colour.
    let builder = match config
        .background_color
        .as_deref()
        .and_then(crate::config::parse_color)
        .filter(|_| !config.transparent)
    {
        Some(colour) => builder.with_background_color(colour),
        None => builder,
    };

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

/// What a webview is told about its own presentation.
///
/// Grouped because they travel together and are all decided by the window's
/// config: the room the title bar left, what shows before the first paint,
/// and whether the page scrolls as a document at all.
struct Presentation {
    title_bar: crate::chrome::titlebar::Metrics,
    background: Option<(u8, u8, u8, u8)>,
    scroll: bool,
    /// The four radii, or `None` for the platform's own corners.
    corners: Option<crate::config::Radii>,
}

fn build_webview(
    rt: &Arc<Runtime>,
    window: &Window,
    proxy: EventLoopProxy<UserEvent>,
    label: &str,
    url: &str,
    look: Presentation,
) -> Result<WebView, String> {
    let resources = webview::Resources::new(&rt.resource_dir);
    let devtools = rt.config.devtools.unwrap_or_else(|| rt.is_dev());
    let source = label.to_string();
    let loaded_label = label.to_string();
    let load_proxy = proxy.clone();

    let builder = WebViewBuilder::new()
        .with_initialization_script(webview::init_script(rt, label, look.title_bar, look.scroll))
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

    // Only where the window is not transparent: a colour behind a window meant
    // to show what is behind it is not a background, it is the end of the
    // effect.
    let builder = match look.background.filter(|_| !rt.config.window.transparent) {
        Some(colour) => builder.with_background_color(colour),
        None => builder,
    };

    let webview = attach(builder, window)?;
    round_corners(&webview, look.corners, look.background);
    Ok(webview)
}

/// Clip the window to its corner radii.
///
/// One radius on all four corners is a `cornerRadius` on the layer, which the
/// platform draws itself and keeps right through a resize for free. Four
/// different radii is not something a layer can express, so that case gets a
/// shape mask - a path the runtime builds and has to rebuild whenever the
/// window changes size, which is why `reshape_corners` exists.
///
/// The page is clipped either way, so content cannot spill past a corner.
/// macOS for now; the radii are read on every platform so they are not dead
/// code where nothing acts on them.
fn round_corners(
    webview: &WebView,
    radii: Option<crate::config::Radii>,
    background: Option<(u8, u8, u8, u8)>,
) {
    let Some(radii) = radii else {
        return;
    };

    #[cfg(target_os = "macos")]
    {
        use wry::WebViewExtMacOS;
        unsafe {
            let ns_window = webview.ns_window();
            let Some(content) = ns_window.contentView() else {
                return;
            };
            let _: () = objc2::msg_send![&*content, setWantsLayer: true];
            let layer: *mut objc2::runtime::AnyObject = objc2::msg_send![&*content, layer];
            if layer.is_null() {
                return;
            }

            let _: () = objc2::msg_send![layer, setMasksToBounds: true];

            // A window given a background colour is opaque, and paints that
            // colour across its whole square frame - behind the rounded
            // content view, filling the corners back in. So the colour moves
            // to the layer that is actually clipped, which keeps what it was
            // for: something to look at before the page has painted.
            if let Some((red, green, blue, alpha)) = background {
                let clear: *mut objc2::runtime::AnyObject =
                    objc2::msg_send![objc2::class!(NSColor), clearColor];
                let _: () = objc2::msg_send![&*ns_window, setOpaque: false];
                let _: () = objc2::msg_send![&*ns_window, setBackgroundColor: clear];

                let colour = CGColorCreateGenericRGB(
                    f64::from(red) / 255.0,
                    f64::from(green) / 255.0,
                    f64::from(blue) / 255.0,
                    f64::from(alpha) / 255.0,
                );
                let _: () = objc2::msg_send![layer, setBackgroundColor: colour];
                CGColorRelease(colour);
            }

            if let Some(radius) = radii.uniform() {
                let _: () = objc2::msg_send![layer, setCornerRadius: radius];
                let _: () =
                    objc2::msg_send![layer, setMask: std::ptr::null::<objc2::runtime::AnyObject>()];
                return;
            }

            // A layer has one `cornerRadius`, so four different ones are drawn
            // by masking with a path instead.
            let _: () = objc2::msg_send![layer, setCornerRadius: 0.0f64];
            apply_shape(layer, radii);
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (webview, radii, background);
}

/// Mask a layer with a rounded-rectangle path of four independent radii.
///
/// Rebuilt from the layer's current bounds every time, because a path is fixed
/// geometry: unlike `cornerRadius` it does not follow the layer when the
/// window resizes.
#[cfg(target_os = "macos")]
unsafe fn apply_shape(layer: *mut objc2::runtime::AnyObject, radii: crate::config::Radii) {
    use objc2_foundation::NSRect;

    let bounds: NSRect = unsafe { objc2::msg_send![layer, bounds] };
    let (w, h) = (bounds.size.width, bounds.size.height);
    if w <= 0.0 || h <= 0.0 {
        return;
    }

    // No corner may eat more than half an edge, or the arcs cross over.
    let cap = (w.min(h)) / 2.0;
    let tl = radii.top_left.min(cap);
    let tr = radii.top_right.min(cap);
    let bl = radii.bottom_left.min(cap);
    let br = radii.bottom_right.min(cap);

    unsafe {
        let path = CGPathCreateMutable();
        if path.is_null() {
            return;
        }

        // Core Graphics puts the origin at the bottom left, so `h` is the top.
        let nil = std::ptr::null();
        CGPathMoveToPoint(path, nil, bl, 0.0);
        CGPathAddLineToPoint(path, nil, w - br, 0.0);
        CGPathAddArcToPoint(path, nil, w, 0.0, w, br, br);
        CGPathAddLineToPoint(path, nil, w, h - tr);
        CGPathAddArcToPoint(path, nil, w, h, w - tr, h, tr);
        CGPathAddLineToPoint(path, nil, tl, h);
        CGPathAddArcToPoint(path, nil, 0.0, h, 0.0, h - tl, tl);
        CGPathAddLineToPoint(path, nil, 0.0, bl);
        CGPathAddArcToPoint(path, nil, 0.0, 0.0, bl, 0.0, bl);
        CGPathCloseSubpath(path);

        let shape: *mut objc2::runtime::AnyObject =
            objc2::msg_send![objc2::class!(CAShapeLayer), layer];
        let _: () = objc2::msg_send![shape, setPath: path];
        let _: () = objc2::msg_send![shape, setFrame: bounds];
        let _: () = objc2::msg_send![layer, setMask: shape];

        CGPathRelease(path);
    }
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPathCreateMutable() -> *mut std::ffi::c_void;
    fn CGPathMoveToPoint(path: *mut std::ffi::c_void, m: *const std::ffi::c_void, x: f64, y: f64);
    fn CGPathAddLineToPoint(
        path: *mut std::ffi::c_void,
        m: *const std::ffi::c_void,
        x: f64,
        y: f64,
    );
    fn CGPathAddArcToPoint(
        path: *mut std::ffi::c_void,
        m: *const std::ffi::c_void,
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        radius: f64,
    );
    fn CGPathCloseSubpath(path: *mut std::ffi::c_void);
    fn CGPathRelease(path: *mut std::ffi::c_void);
    fn CGColorCreateGenericRGB(r: f64, g: f64, b: f64, a: f64) -> *mut std::ffi::c_void;
    fn CGColorRelease(colour: *mut std::ffi::c_void);
}

/// Whether the window keeps a frame of its own.
///
/// A hidden title bar has no bar to decorate. On macOS the decorations stay
/// on - that is what keeps the traffic lights, and the bar itself is removed
/// by the platform-specific calls elsewhere. Everywhere else the only way to
/// lose the bar is to lose the frame with it.
fn has_decorations(config: &crate::config::WindowConfig) -> bool {
    let hidden = config.title_bar_style == TitleBarStyle::Hidden;
    if hidden && !cfg!(target_os = "macos") {
        false
    } else {
        config.decorations
    }
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
