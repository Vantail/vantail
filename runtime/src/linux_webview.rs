//! The GTK container a Linux webview is built on.
//!
//! On Linux a webview must be built with `build_gtk` on a GTK container, not
//! with `build` on the tao window: `build` takes the X11 handle, which does
//! not exist under Wayland, where it fails and no window ever appears.
//! `build_gtk` works on both X11 and Wayland.
//!
//! The container is picked at runtime, most specific first:
//!
//! 1. `default_vbox` - the vertical box tao puts in every window it makes.
//!    This is the normal case, and keeps the `pack_start` layout wry expects.
//! 2. Whatever container the window actually holds - found by looking at the
//!    GTK window's child rather than by naming tao's field. This is what keeps
//!    working if tao ever renames `default_vbox`, changes its type, or stops
//!    adding one: the webview lands in whatever is there.
//! 3. The GTK window itself - the case where the window has no child at all
//!    (tao built with `with_default_vbox(false)`, or a window adopted with
//!    `new_from_gtk_window`, which sets no default box). A `GtkWindow` is a
//!    `Container`, so `build_gtk` accepts it directly.
//!
//! One place, used by both normal windows and the hidden print view, so a tao
//! change breaks - and is fixed - exactly once.

use tao::window::Window;
use wry::{WebView, WebViewBuilder};

/// Build a Linux webview on the window's GTK container (see module docs).
pub fn build(window: &Window, builder: WebViewBuilder<'_>) -> Result<WebView, String> {
    use tao::platform::unix::WindowExtUnix;
    use wry::WebViewBuilderExtUnix;

    if let Some(vbox) = window.default_vbox() {
        return builder
            .build_gtk(vbox)
            .map_err(|e| format!("Could not create the webview: {e}"));
    }

    // tao's box is missing - find whatever container is actually there.
    if let Some(container) = gtk_child_container(window) {
        return builder
            .build_gtk(&container)
            .map_err(|e| format!("Could not create the webview: {e}"));
    }

    builder
        .build_gtk(window.gtk_window())
        .map_err(|e| format!("Could not create the webview: {e}"))
}

/// The window's current child, if it is a GTK container.
///
/// Reached through `gtk_window` rather than `default_vbox`, so this keeps
/// working no matter what tao names its field or which widget type it puts
/// there.
fn gtk_child_container(window: &Window) -> Option<gtk::Container> {
    use gtk::prelude::*;
    use tao::platform::unix::WindowExtUnix;

    window
        .gtk_window()
        .child()
        .and_then(|child| child.dynamic_cast::<gtk::Container>().ok())
}
