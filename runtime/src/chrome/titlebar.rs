//! How much room the title bar takes, so an application does not have to guess.
//!
//! With `titleBarStyle: "hidden"` the page runs to the top edge of the window
//! and the application draws its own toolbar there. Two numbers decide whether
//! that toolbar looks native or nearly-native: how tall the bar it replaced
//! was, and how much of the leading edge the system's own buttons occupy.
//!
//! Both are knowable, and neither should be a constant an application copies
//! out of a blog post - the title bar is 28pt on one macOS release and could
//! be something else on the next, and the buttons move when the window is a
//! different style. So they are measured from the window itself and handed to
//! the page before its first paint, as CSS variables and on the bridge.

use serde::Serialize;

/// The room a title bar would have taken, in logical pixels.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    /// How tall the platform's own title bar is.
    pub height: f64,
    /// Room the system's window buttons need on the leading edge. Zero where
    /// the application draws its own.
    pub inset_left: f64,
    /// The same on the trailing edge. Zero on macOS, where the lights are
    /// always on the left.
    pub inset_right: f64,
    /// The gap above the system's window buttons.
    ///
    /// What a bar taller than the buttons needs in order to line anything up
    /// with them. `insetLeft` says how much room they take across; this says
    /// where they sit down the bar, which is not something an application can
    /// work out: the platform does not always centre them, and only it knows
    /// where it put them.
    ///
    /// Zero, with `button_height`, where there are no system buttons - hidden,
    /// or a platform that loses them with the title bar - which is the same
    /// signal `inset_left` gives.
    pub button_top: f64,
    /// How tall those buttons are.
    pub button_height: f64,
}

impl Metrics {
    /// What a window with an ordinary title bar reports: no space to leave,
    /// because the application is not drawing in it.
    pub fn none() -> Self {
        Self {
            height: 0.0,
            inset_left: 0.0,
            inset_right: 0.0,
            button_top: 0.0,
            button_height: 0.0,
        }
    }
}

/// Where the window buttons should be: the answer to "where do they go",
/// separate from the AppKit calls that put them there.
/// Make the title bar `height` tall, and put the window buttons in it.
///
/// The trick is which view to resize. The buttons live in an `NSTitlebarView`
/// inside an `NSTitlebarContainerView`, and it is the *container* whose frame
/// is in the window's coordinates - so it is the one that can be grown and
/// re-pinned to the top edge. Growing the inner view instead sets an origin
/// against a parent barely thirty points tall, which puts it hundreds of
/// points above the window and takes the buttons out of sight with it. That is
/// what "resizing the container makes the lights vanish" turned out to be:
/// they did not vanish, they left.
///
/// With the container the right size, the buttons go a margin up from its
/// bottom edge, which is the same margin down from its top - so they land
/// centred in whatever height was asked for, by arithmetic rather than by
/// asking macOS to centre them.
///
/// AppKit undoes all of this on every relayout, so it has to be applied again
/// after every resize - which is what `reapply_title_bar` is for. That is the
/// same shape Electron's `WindowButtonsProxy` has, and the reason this is
/// possible at all: the technique came from reading it.
#[cfg(target_os = "macos")]
fn grow(
    window: &tao::window::Window,
    height: f64,
    lights: Option<(f64, f64)>,
    home_x: f64,
) -> Option<f64> {
    use objc2_app_kit::NSWindowButton;
    use objc2_foundation::NSPoint;

    let ns = unsafe { ns_of(window) }?;

    let buttons: Vec<_> = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .filter_map(|kind| ns.standardWindowButton(kind))
    .collect();
    let first = buttons.first()?;
    let inner = unsafe { first.superview() }?;
    let container = unsafe { inner.superview() }?;

    let button_height = first.frame().size.height;
    let mut frame = container.frame();
    frame.size.height = height.max(button_height);
    // Without this the container grows off the top of the window: its frame is
    // in coordinates that count up from the bottom.
    frame.origin.y = ns.frame().size.height - frame.size.height;
    container.setFrame(frame);

    // `top` is a gap measured down from the top of the bar, which is how an
    // application thinks about it; the frames count up from the bottom.
    let top = match lights {
        Some((_, top)) => top,
        None => ((frame.size.height - button_height) / 2.0).max(0.0),
    };
    let y = (frame.size.height - top - button_height).max(0.0);

    // Keep the spacing the system chose between the three: only the group
    // moves, and the gaps are the platform's. The offsets are taken from where
    // the buttons are now, which is fine because only the group's leading edge
    // is being decided here - and that comes from `home_x`, the position the
    // platform gave them, not from wherever they were last put.
    let start = first.frame().origin.x;
    let offsets: Vec<f64> = buttons.iter().map(|b| b.frame().origin.x - start).collect();
    let leading = lights.map(|(x, _)| x).unwrap_or(home_x);
    for (button, offset) in buttons.iter().zip(offsets) {
        button.setFrameOrigin(NSPoint::new(leading + offset, y));
    }

    Some(frame.size.height)
}

#[cfg(target_os = "macos")]
unsafe fn ns_of(window: &tao::window::Window) -> Option<&objc2_app_kit::NSWindow> {
    use tao::platform::macos::WindowExtMacOS;
    let p = window.ns_window() as *mut objc2_app_kit::NSWindow;
    if p.is_null() {
        None
    } else {
        Some(&*p)
    }
}

/// What the platform's own title bar measures, before any override.
#[derive(Debug, Clone, Copy)]
pub struct Native {
    pub height: f64,
    /// The whole run reserved on the leading edge: gap, buttons, gap.
    pub inset_left: f64,
    /// How tall the window buttons are, as measured.
    #[cfg(target_os = "macos")]
    pub button_height: f64,
    /// Where the leading edge of the first button sits, as measured.
    ///
    /// Kept so "put them back" has something to put them back to. Reading it
    /// off the buttons at the time would answer with wherever they were last
    /// moved to, which is how re-centring them quietly stopped re-centring
    /// them.
    #[cfg(target_os = "macos")]
    pub button_x: f64,
    /// The gap the platform leaves above the buttons, measured.
    ///
    /// Not derived by centring them in the bar, because the platform does not
    /// always centre them: in a two-row bar the buttons belong to the top row
    /// and sit well above the middle. Computing a centre and setting it would
    /// move them 8px on every resize - which is a jump you can see, and did.
    #[cfg(target_os = "macos")]
    pub button_top: f64,
}

/// Show or hide the platform's own window buttons.
///
/// Hiding them is how an application draws its own on macOS, which is the only
/// platform that keeps them once the title bar is gone. Everywhere else there
/// is nothing to hide and this does nothing.
#[cfg(target_os = "macos")]
pub fn set_buttons_hidden(window: &tao::window::Window, hidden: bool) {
    use objc2_app_kit::NSWindowButton;

    let Some(ns) = (unsafe { ns_of(window) }) else {
        return;
    };
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        if let Some(button) = ns.standardWindowButton(kind) {
            button.setHidden(hidden);
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_buttons_hidden(_window: &tao::window::Window, _hidden: bool) {}

/// The numbers to hand the page, for a bar of `height`.
///
/// `system_buttons` false - the platform's buttons hidden, or a platform that
/// loses them along with the title bar - means nothing is reserved and there
/// is nothing to line up with, which is the signal an application uses to
/// decide it has to draw its own.
pub fn metrics_for(native: Native, height: f64, system_buttons: bool) -> Metrics {
    if !system_buttons {
        return Metrics {
            height,
            inset_left: 0.0,
            inset_right: 0.0,
            button_top: 0.0,
            button_height: 0.0,
        };
    }

    Metrics {
        height,
        inset_left: native.inset_left,
        inset_right: 0.0,
        #[cfg(target_os = "macos")]
        button_top: native.button_top,
        #[cfg(target_os = "macos")]
        button_height: native.button_height,
        #[cfg(not(target_os = "macos"))]
        button_top: 0.0,
        #[cfg(not(target_os = "macos"))]
        button_height: 0.0,
    }
}

/// Shape the title bar to `requested`, and answer with the height it became.
///
/// Any height, not one of a handful: the window buttons are centred in the bar
/// by arithmetic, so there is nothing to round to. The only floor is the
/// buttons themselves having to fit.
#[cfg(target_os = "macos")]
pub fn fit(
    window: &tao::window::Window,
    requested: Option<f64>,
    platform: Native,
    lights: Option<(f64, f64)>,
) -> f64 {
    let height = requested.filter(|h| *h > 0.0).unwrap_or(platform.height);
    grow(window, height, lights, platform.button_x).unwrap_or(platform.height)
}

/// No system buttons to move and no container to grow: the application draws
/// the whole bar, and the number it asked for is the answer.
#[cfg(not(target_os = "macos"))]
pub fn fit(
    _window: &tao::window::Window,
    requested: Option<f64>,
    platform: Native,
    _lights: Option<(f64, f64)>,
) -> f64 {
    requested.filter(|h| *h > 0.0).unwrap_or(platform.height)
}

/// Measure the platform's own title bar, before anything has been moved.
///
/// Taken once per window and kept: the numbers come off the window buttons,
/// and once those have been repositioned a fresh measurement describes where
/// they were put rather than where the platform puts them. Re-measuring is
/// how "put them back" quietly stopped putting them back.
#[cfg(target_os = "macos")]
pub fn native(window: &tao::window::Window) -> Native {
    use objc2_app_kit::{NSWindow, NSWindowButton};
    use tao::platform::macos::WindowExtMacOS;

    let pointer = window.ns_window() as *mut NSWindow;
    if pointer.is_null() {
        return native_fallback();
    }

    // Safety: the pointer comes from the window we were handed, which
    // outlives this call, and everything below is read on the main thread -
    // the only thread a window is ever built on.
    let ns: &NSWindow = unsafe { &*pointer };

    // `contentLayoutRect` is the part of the window a title bar is not
    // covering, which is exactly the question - and it stays right when the
    // content view has been told to run the full height.
    let frame = ns.frame();
    let content = ns.contentLayoutRect();
    let height = frame.size.height - content.size.height;

    let (inset_left, button_height, button_top, button_x) = match (
        ns.standardWindowButton(NSWindowButton::CloseButton),
        ns.standardWindowButton(NSWindowButton::ZoomButton),
    ) {
        (Some(close), Some(zoom)) => {
            // The container is what the frames are relative to, so the gap
            // above the buttons has to be read against it.
            let container = unsafe { close.superview() }
                .map(|view| view.frame().size.height)
                .unwrap_or_default();
            let close = close.frame();
            let zoom = zoom.frame();
            // The gap to the left of the first light, repeated after the last
            // one - which is what makes a toolbar look spaced by the system
            // rather than by a guess.
            let right_edge = zoom.origin.x + zoom.size.width;
            (
                right_edge + close.origin.x,
                close.size.height,
                container - close.origin.y - close.size.height,
                close.origin.x,
            )
        }
        // A window without the standard buttons has nothing to leave room for.
        _ => (0.0, 0.0, 0.0, 0.0),
    };

    if height <= 0.0 {
        return native_fallback();
    }

    Native {
        height,
        inset_left,
        button_height,
        button_top,
        button_x,
    }
}

/// Windows and Linux have no title bar left to measure.
///
/// `hidden` there is an undecorated window - there is no way to keep the
/// system's buttons without the frame they live in - so the application draws
/// its own controls and there is no inset to reserve. The height is still
/// worth reporting: it is what the platform's own bar would have been, so a
/// toolbar that uses it looks like it belongs.
#[cfg(not(target_os = "macos"))]
pub fn native(_window: &tao::window::Window) -> Native {
    native_fallback()
}

fn native_fallback() -> Native {
    Native {
        height: fallback().height,
        inset_left: 0.0,
        #[cfg(target_os = "macos")]
        button_height: 0.0,
        #[cfg(target_os = "macos")]
        button_top: 0.0,
        #[cfg(target_os = "macos")]
        button_x: 0.0,
    }
}

fn fallback() -> Metrics {
    Metrics {
        // Logical pixels, so these do not change with the display's scale.
        // macOS is only reached here if the measurement failed.
        height: if cfg!(target_os = "windows") {
            32.0
        } else if cfg!(target_os = "macos") {
            28.0
        } else {
            37.0
        },
        inset_left: 0.0,
        inset_right: 0.0,
        // Only reached when the measurement failed, so there is nothing
        // trustworthy to say about where the buttons are.
        button_top: 0.0,
        button_height: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a real window reports.
    fn measured() -> Native {
        Native {
            height: 32.0,
            inset_left: 78.0,
            #[cfg(target_os = "macos")]
            button_height: 14.0,
            #[cfg(target_os = "macos")]
            button_top: 9.0,
            #[cfg(target_os = "macos")]
            button_x: 9.0,
        }
    }

    #[test]
    fn an_ordinary_title_bar_reserves_nothing() {
        // Nothing to leave room for when the application is not drawing there.
        let metrics = Metrics::none();
        assert_eq!(metrics.height, 0.0);
        assert_eq!(metrics.inset_left, 0.0);
        assert_eq!(metrics.inset_right, 0.0);
    }

    #[test]
    fn the_fallback_is_a_real_height_rather_than_zero() {
        // A zero would collapse a toolbar sized from it, which is a worse
        // failure than being a few pixels out.
        assert!(fallback().height > 20.0);
    }

    #[test]
    fn the_reported_height_is_the_one_that_was_asked_for() {
        // Any height, on every platform: the window buttons are centred in
        // the bar by arithmetic, so there is nothing to round to.
        let metrics = metrics_for(measured(), 44.0, true);
        assert_eq!(metrics.height, 44.0);
        assert_eq!(metrics_for(measured(), 57.0, true).height, 57.0);
    }

    #[test]
    fn where_the_buttons_are_is_reported_alongside_the_room_they_take() {
        let metrics = metrics_for(measured(), 44.0, true);
        assert_eq!(metrics.inset_left, 78.0);
        // Only macOS keeps window buttons once the title bar is gone, so only
        // there is there anything to line up with.
        if cfg!(target_os = "macos") {
            assert_eq!(metrics.button_top, 9.0);
            assert_eq!(metrics.button_height, 14.0);
        } else {
            assert_eq!(metrics.button_top, 0.0);
            assert_eq!(metrics.button_height, 0.0);
        }
    }

    #[test]
    fn an_application_drawing_its_own_buttons_is_told_nothing_is_reserved() {
        // The same signal Windows and Linux always give, so a page that draws
        // its own controls when nothing is reserved needs no new branch.
        let metrics = metrics_for(measured(), 44.0, false);
        assert_eq!(metrics.height, 44.0);
        assert_eq!(metrics.inset_left, 0.0);
        assert_eq!(metrics.button_top, 0.0);
        assert_eq!(metrics.button_height, 0.0);
    }

    #[test]
    fn metrics_serialise_the_way_the_bridge_expects() {
        let json = serde_json::to_value(Metrics {
            height: 44.0,
            inset_left: 78.0,
            inset_right: 0.0,
            button_top: 15.0,
            button_height: 14.0,
        })
        .unwrap();
        assert_eq!(json["height"], 44.0);
        assert_eq!(json["insetLeft"], 78.0);
        assert_eq!(json["insetRight"], 0.0);
        assert_eq!(json["buttonTop"], 15.0);
        assert_eq!(json["buttonHeight"], 14.0);
    }
}
