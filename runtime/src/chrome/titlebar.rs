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
}

impl Metrics {
    /// What a window with an ordinary title bar reports: no space to leave,
    /// because the application is not drawing in it.
    pub fn none() -> Self {
        Self {
            height: 0.0,
            inset_left: 0.0,
            inset_right: 0.0,
        }
    }
}

/// Where a button belongs across the bar, given where the platform put it.
///
/// Absolute rather than a nudge from wherever the button happens to be now.
/// The placement has to be repeatable - AppKit undoes it on every resize, so
/// it is applied again and again - and a relative shift applied twice moves
/// the lights twice. Anchoring to the measured native positions means running
/// it a hundred times during a drag lands them in the same place as running
/// it once, while keeping the spacing the system chose between the three.
#[cfg(target_os = "macos")]
fn button_origin_x(native: &Native, index: usize, x: f64) -> f64 {
    x + native.button_x[index] - native.button_x[0]
}

/// Put the traffic lights at `x` across and `top` down from the window's top.
///
/// Done by moving the buttons rather than through tao's
/// `set_traffic_light_inset`. That resizes the title bar container and lets
/// AppKit re-lay the buttons inside it, and on current macOS the resize does
/// not stick: the container measures 32 again by the time anything reads it,
/// so the lights never move vertically however the inset is calculated.
/// Setting the frames is the part that holds.
///
/// The container is anchored to the top of the window, so `top` is a gap
/// above the buttons - expressed here in its bottom-left coordinates.
#[cfg(target_os = "macos")]
fn place_window_buttons(window: &tao::window::Window, x: f64, top: f64, native: &Native) {
    use objc2_app_kit::NSWindowButton;

    let Some(ns) = (unsafe { ns_of(window) }) else {
        return;
    };

    for (index, kind) in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .enumerate()
    {
        let Some(button) = ns.standardWindowButton(kind) else {
            continue;
        };
        let Some(container) = (unsafe { button.superview() }) else {
            continue;
        };

        let frame = button.frame();
        let mut origin = frame.origin;
        origin.x = button_origin_x(native, index, x);
        origin.y = container.frame().size.height - top - frame.size.height;
        // The container AppKit gives us is only as tall as the platform's own
        // bar, and it cannot be grown - resizing it makes the buttons vanish,
        // and letting them past its bottom edge draws them somewhere AppKit
        // will not hit-test. So centring is exact until the room runs out and
        // then stops, which for a very tall bar means the lights sit a little
        // above centre. Live and slightly high beats centred and dead.
        origin.y = origin.y.max(0.0);
        button.setFrameOrigin(origin);
    }
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
    /// Where the platform put each of close, minimise and zoom across the
    /// bar, measured rather than derived.
    ///
    /// Kept as three numbers rather than a start and a stride because the
    /// gaps are the system's to choose, and because moving the group has to
    /// be repeatable: every placement is worked out from these, so it lands
    /// in the same spot however many times it runs.
    ///
    /// macOS only, and not merely unused elsewhere: nowhere else keeps its
    /// window buttons when the title bar goes, so there is nothing to
    /// measure and nothing to move.
    #[cfg(target_os = "macos")]
    pub button_x: [f64; 3],
    /// How tall the window buttons are, which is what centring them needs.
    #[cfg(target_os = "macos")]
    pub button_height: f64,
}

#[cfg(target_os = "macos")]
impl Native {
    /// Where the leading edge of the first button sits by default.
    fn inset_start(&self) -> f64 {
        self.button_x[0]
    }
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

/// How tall the bar is: what the application asked for, or the platform's.
fn height_with(native: &Native, requested: Option<f64>) -> f64 {
    requested.filter(|h| *h > 0.0).unwrap_or(native.height)
}

/// Put the window buttons where the current settings say they belong.
///
/// Separate from measuring because it has to run far more often than the
/// numbers change: AppKit re-lays the title bar out on every resize, undoing
/// any frame that was set, so a window whose lights were moved needs them put
/// back on each `Resized` - and telling the page its metrics a hundred times
/// during a drag, to say nothing they did not already know, is not something
/// to do on the way.
pub fn place(
    window: &tao::window::Window,
    native: Native,
    requested: Option<f64>,
    lights: Option<(f64, f64)>,
) {
    #[cfg(target_os = "macos")]
    {
        // An explicit position wins; otherwise centre them in whatever height
        // is in force, including the platform's own - going back to it has to
        // move the lights back too.
        let (x, top) = lights.unwrap_or((
            native.inset_start(),
            ((height_with(&native, requested) - native.button_height) / 2.0).max(0.0),
        ));
        place_window_buttons(window, x, top, &native);
    }
    // Nothing to place: the platforms that lose their window buttons with the
    // title bar have none to move.
    #[cfg(not(target_os = "macos"))]
    let _ = (window, native, requested, lights);
}

/// Measure a window's title bar, honouring a height the application asked for.
///
/// `requested` taller than the platform's own is the browser-toolbar case: the
/// height reported to the page changes, and the traffic lights move to the
/// middle of the new height. Everything else stays the platform's.
pub fn measure_with(
    window: &tao::window::Window,
    native: Native,
    requested: Option<f64>,
    lights: Option<(f64, f64)>,
) -> Metrics {
    place(window, native, requested, lights);

    Metrics {
        height: height_with(&native, requested),
        inset_left: native.inset_left,
        inset_right: 0.0,
    }
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

    let (inset_left, button_x, button_height) = match (
        ns.standardWindowButton(NSWindowButton::CloseButton),
        ns.standardWindowButton(NSWindowButton::MiniaturizeButton),
        ns.standardWindowButton(NSWindowButton::ZoomButton),
    ) {
        (Some(close), Some(minimise), Some(zoom)) => {
            let close = close.frame();
            let minimise = minimise.frame();
            let zoom = zoom.frame();
            // The gap to the left of the first light, repeated after the last
            // one - which is what makes a toolbar look spaced by the system
            // rather than by a guess.
            let right_edge = zoom.origin.x + zoom.size.width;
            (
                right_edge + close.origin.x,
                [close.origin.x, minimise.origin.x, zoom.origin.x],
                close.size.height,
            )
        }
        // A window without the standard buttons has nothing to leave room for.
        _ => (0.0, [0.0; 3], 0.0),
    };

    if height <= 0.0 {
        return native_fallback();
    }

    Native {
        height,
        inset_left,
        button_x,
        button_height,
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
        button_x: [0.0; 3],
        #[cfg(target_os = "macos")]
        button_height: 0.0,
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// What a real window reports: three lights, evenly spaced.
    #[cfg(target_os = "macos")]
    fn measured() -> Native {
        Native {
            height: 28.0,
            inset_left: 78.0,
            button_x: [7.0, 27.0, 47.0],
            button_height: 12.0,
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn moving_the_lights_keeps_the_spacing_the_system_chose() {
        let native = measured();
        let placed = [0, 1, 2].map(|i| button_origin_x(&native, i, 12.0));
        // The group lands where it was asked to, and the gaps are still the
        // platform's rather than a guess.
        assert_eq!(placed, [12.0, 32.0, 52.0]);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn placing_twice_lands_where_placing_once_did() {
        let native = measured();
        // Stand in for the buttons themselves. AppKit puts them back on every
        // resize, so the placement runs again on each frame of a drag -
        // anything cumulative walks the lights across the bar while the user
        // holds the corner, which is exactly what a relative nudge did.
        let mut positions = native.button_x;
        for _ in 0..5 {
            for (index, position) in positions.iter_mut().enumerate() {
                *position = button_origin_x(&native, index, 12.0);
            }
        }
        assert_eq!(positions, [12.0, 32.0, 52.0]);
    }

    #[test]
    fn an_asked_for_height_wins_over_the_platform_s() {
        let native = native_fallback();
        assert_eq!(height_with(&native, Some(44.0)), 44.0);
        // Nonsense heights fall back rather than collapsing the bar.
        assert_eq!(height_with(&native, Some(0.0)), native.height);
        assert_eq!(height_with(&native, None), native.height);
    }

    #[test]
    fn metrics_serialise_the_way_the_bridge_expects() {
        let json = serde_json::to_value(Metrics {
            height: 28.0,
            inset_left: 78.0,
            inset_right: 0.0,
        })
        .unwrap();
        assert_eq!(json["height"], 28.0);
        assert_eq!(json["insetLeft"], 78.0);
        assert_eq!(json["insetRight"], 0.0);
    }
}
