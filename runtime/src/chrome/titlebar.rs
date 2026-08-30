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

/// What the title bar should look like.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy)]
struct Shape {
    height: f64,
    /// An explicit `trafficLightPosition`, or `None` to centre them.
    lights: Option<(f64, Option<f64>)>,
    /// Where the platform put the first button, which is what "no explicit
    /// position" resolves to.
    home_x: f64,
}

/// The shape to restore, shared with the observer that restores it.
///
/// Held rather than captured, so a change of height reaches the observer with
/// nothing re-registered.
#[cfg(target_os = "macos")]
#[derive(Clone, Default)]
pub struct Keeper(std::sync::Arc<std::sync::Mutex<Option<Shape>>>);

/// Nothing to keep: no other platform has window buttons left to move.
///
/// Carries a unit rather than being one, so the call that builds it reads the
/// same on every platform.
#[cfg(not(target_os = "macos"))]
#[derive(Clone, Default)]
pub struct Keeper(());

#[cfg(target_os = "macos")]
impl Keeper {
    fn get(&self) -> Option<Shape> {
        *self.0.lock().expect("the title bar shape lock")
    }

    fn set(&self, shape: Option<Shape>) {
        *self.0.lock().expect("the title bar shape lock") = shape;
    }
}

/// Holds the view that keeps the bar in shape, for as long as the window does.
#[cfg(target_os = "macos")]
pub struct Watch(#[allow(dead_code)] Option<objc2::rc::Retained<hook::Hook>>);

#[cfg(not(target_os = "macos"))]
pub struct Watch;

/// The window buttons, and the container whose height decides the bar.
///
/// The container is the buttons' *grand*parent. `NSTitlebarContainerView` is
/// the one whose frame is in the window's coordinates, so it is the one that
/// can be grown and re-pinned to the top edge. Growing the `NSTitlebarView`
/// inside it instead sets an origin against a parent barely thirty points
/// tall, which puts it hundreds of points above the window and takes the
/// buttons with it - which is what "resizing the container makes the lights
/// vanish" turned out to be. They did not vanish; they left.
#[cfg(target_os = "macos")]
#[allow(clippy::type_complexity)]
fn parts(
    ns: &objc2_app_kit::NSWindow,
) -> Option<(
    objc2::rc::Retained<objc2_app_kit::NSView>,
    Vec<objc2::rc::Retained<objc2_app_kit::NSButton>>,
)> {
    use objc2_app_kit::NSWindowButton;

    let buttons: Vec<_> = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .filter_map(|kind| ns.standardWindowButton(kind))
    .collect();
    let inner = unsafe { buttons.first()?.superview() }?;
    Some((unsafe { inner.superview() }?, buttons))
}

/// Give the container its height, and put the buttons where they belong in it.
#[cfg(target_os = "macos")]
fn apply(
    ns: &objc2_app_kit::NSWindow,
    container: &objc2_app_kit::NSView,
    buttons: &[objc2::rc::Retained<objc2_app_kit::NSButton>],
    shape: Shape,
) -> f64 {
    use objc2_foundation::NSPoint;

    let Some(first) = buttons.first() else {
        return shape.height;
    };
    let button_height = first.frame().size.height;

    let mut frame = container.frame();
    frame.size.height = shape.height.max(button_height);
    // Without this the container grows off the top of the window: its frame is
    // in coordinates that count up from the bottom.
    frame.origin.y = ns.frame().size.height - frame.size.height;
    container.setFrame(frame);

    // `top` is a gap measured down from the top of the bar, which is how an
    // application thinks about it; the frames count up from the bottom.
    let centred = ((frame.size.height - button_height) / 2.0).max(0.0);
    let top = match shape.lights {
        Some((_, Some(top))) => top,
        // A position with no `y`: moved across, left where it was vertically.
        Some((_, None)) | None => centred,
    };
    let y = (frame.size.height - top - button_height).max(0.0);

    // Only the group moves; the gaps between the three stay the platform's.
    let start = first.frame().origin.x;
    let offsets: Vec<f64> = buttons.iter().map(|b| b.frame().origin.x - start).collect();
    let leading = shape.lights.map(|(x, _)| x).unwrap_or(shape.home_x);
    for (button, offset) in buttons.iter().zip(offsets) {
        button.setFrameOrigin(NSPoint::new(leading + offset, y));
    }

    frame.size.height
}

/// A view of our own in the title bar, whose only job is to be drawn.
///
/// AppKit puts the window buttons back where it wants them on every relayout,
/// and it does that before the resize reaches the event loop - so correcting
/// from the `Resized` handler is always a frame late, and a frame late is a
/// frame in which the buttons are visibly somewhere else.
///
/// The fix is to correct while the title bar is being *drawn*, which is after
/// AppKit has finished laying out and before anything reaches the screen. tao
/// does exactly this for its own traffic light inset, from the `drawRect:` of
/// the window's content view - but that view is a `WKWebView` here, so the
/// hook never runs. This is the same hook, on a view that does get drawn:
/// a subview of the title bar container, sized to it and painting nothing.
///
/// It never takes a click - `hitTest:` answers null - so the buttons
/// underneath keep theirs.
#[cfg(target_os = "macos")]
mod hook {
    use objc2::rc::Retained;
    use objc2::runtime::NSObjectProtocol;
    use objc2::{define_class, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSButton, NSView, NSWindow};
    use objc2_foundation::{NSPoint, NSRect};

    pub struct Ivars {
        pub keeper: super::Keeper,
        pub container: Retained<NSView>,
        pub buttons: Vec<Retained<NSButton>>,
        /// The window, as an address. Held this way because the window owns
        /// the entry that owns this view, so a strong reference here would be
        /// a cycle - and it outlives every call the view can make.
        pub window: usize,
    }

    define_class!(
        #[unsafe(super(NSView))]
        #[thread_kind = MainThreadOnly]
        #[name = "VantailTitleBarHook"]
        #[ivars = Ivars]
        pub struct Hook;

        unsafe impl NSObjectProtocol for Hook {}

        impl Hook {
            #[unsafe(method(drawRect:))]
            fn draw_rect(&self, _dirty: NSRect) {
                let ivars = self.ivars();
                let Some(shape) = ivars.keeper.get() else {
                    return;
                };
                // Safety: see `Ivars::window`.
                let window = unsafe { &*(ivars.window as *const NSWindow) };
                super::apply(window, &ivars.container, &ivars.buttons, shape);
            }

            /// Never take a click. The window buttons are underneath.
            #[unsafe(method(hitTest:))]
            fn hit_test(&self, _point: NSPoint) -> *mut NSView {
                std::ptr::null_mut()
            }

            #[unsafe(method(isOpaque))]
            fn is_opaque(&self) -> bool {
                false
            }
        }
    );

    impl Hook {
        pub fn new(mtm: MainThreadMarker, ivars: Ivars, frame: NSRect) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(ivars);
            unsafe { objc2::msg_send![super(this), initWithFrame: frame] }
        }
    }
}

/// Put the bar's height back the moment AppKit takes it away.
///
/// AppKit resets the container on every relayout, and does it *before* the
/// resize reaches the event loop - so correcting from the `Resized` handler is
/// always a frame late, and a frame late is a frame in which the buttons are
/// somewhere else. Correcting from inside the layout is not late.
///
/// That this works at all is worth writing down, because the same trick fails
/// on the buttons: a frame set on one of *those* while AppKit is laying out is
/// discarded, as reading it straight back shows. The container keeps what it
/// is given, so the height is restored here and the buttons follow from it.
#[cfg(target_os = "macos")]
pub fn keep(window: &tao::window::Window, keeper: &Keeper) -> Watch {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSAutoresizingMaskOptions;

    let Some(ns) = (unsafe { ns_of(window) }) else {
        return Watch(None);
    };
    let Some((container, buttons)) = parts(ns) else {
        return Watch(None);
    };

    // Safety: windows are only built on the event loop's thread, the main one.
    let mtm = unsafe { MainThreadMarker::new_unchecked() };
    let view = hook::Hook::new(
        mtm,
        hook::Ivars {
            keeper: keeper.clone(),
            container: container.clone(),
            buttons,
            window: ns as *const objc2_app_kit::NSWindow as usize,
        },
        container.bounds(),
    );
    // Follow the container, so it is asked to draw whenever the title bar is -
    // which is every frame of a resize.
    view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    container.addSubview(&view);
    Watch(Some(view))
}

#[cfg(not(target_os = "macos"))]
pub fn keep(_window: &tao::window::Window, _keeper: &Keeper) -> Watch {
    Watch
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
    lights: Option<(f64, Option<f64>)>,
    keeper: &Keeper,
) -> f64 {
    let shape = Shape {
        height: requested.filter(|h| *h > 0.0).unwrap_or(platform.height),
        lights,
        home_x: platform.button_x,
    };
    // Set before anything moves, and not held while it does: moving a view
    // posts the notification the keeper listens on, and the keeper takes this
    // same lock.
    keeper.set(Some(shape));

    let Some(ns) = (unsafe { ns_of(window) }) else {
        return shape.height;
    };
    let Some((container, buttons)) = parts(ns) else {
        return shape.height;
    };
    apply(ns, &container, &buttons, shape)
}

/// No system buttons to move and no container to grow: the application draws
/// the whole bar, and the number it asked for is the answer.
#[cfg(not(target_os = "macos"))]
pub fn fit(
    _window: &tao::window::Window,
    requested: Option<f64>,
    platform: Native,
    _lights: Option<(f64, Option<f64>)>,
    _keeper: &Keeper,
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
