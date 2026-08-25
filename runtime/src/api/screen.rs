//! `screen.*` - the displays a window can be put on.
//!
//! A page can see the screen it is on, through `window.screen`, but not the
//! others and not where they sit relative to each other. Without that,
//! `window.setPosition` is guesswork on any machine with two monitors.
//!
//! Everything here is in **logical** pixels, the same units the window methods
//! take. tao reports monitors in physical pixels, so the scale factor is
//! divided out here - reporting physical would put a window at half the
//! intended coordinates on a Retina display, which is exactly the bug this
//! exists to prevent.

use serde::Deserialize;
use serde_json::{json, Value};
use tao::monitor::MonitorHandle;

use crate::error::{ApiError, ApiResult};
use crate::ipc::request::Request;
use crate::state::MainCtx;

#[derive(Debug, Deserialize)]
struct PointParams {
    x: f64,
    y: f64,
}

pub fn dispatch(ctx: &mut MainCtx<'_>, method: &str, params: Value) -> ApiResult {
    // Screen layout is only useful for placing windows, and is gated with them.
    ctx.rt
        .permissions
        .require(ctx.rt.permissions.window, method)?;

    let primary = ctx.target.primary_monitor();

    match method {
        "screen.list" => Ok(json!(ctx
            .target
            .available_monitors()
            .map(|monitor| describe(&monitor, primary.as_ref()))
            .collect::<Vec<_>>())),

        "screen.primary" => Ok(match primary.as_ref() {
            Some(monitor) => describe(monitor, primary.as_ref()),
            None => Value::Null,
        }),

        // Which screen the calling window is on, so an application can centre
        // a new window where the user is already looking.
        "screen.current" => {
            let entry = ctx.windows.require(ctx.source)?;
            Ok(match entry.window.current_monitor() {
                Some(monitor) => describe(&monitor, primary.as_ref()),
                None => Value::Null,
            })
        }

        "screen.fromPoint" => {
            let PointParams { x, y } = Request::params(method, params)?;
            // The point arrives logical, and tao wants physical.
            let scale = primary.as_ref().map_or(1.0, |m| m.scale_factor());

            let found = ctx
                .target
                .monitor_from_point(x * scale, y * scale)
                // GTK answers with the nearest monitor rather than none, so a
                // point far off every screen comes back as the primary one.
                // Checking the bounds is what makes the answer mean the same
                // thing on every platform.
                .filter(|monitor| contains(monitor, x, y));

            Ok(match found {
                Some(monitor) => describe(&monitor, primary.as_ref()),
                None => Value::Null,
            })
        }

        _ => Err(ApiError::unknown_method(method)),
    }
}

fn describe(monitor: &MonitorHandle, primary: Option<&MonitorHandle>) -> Value {
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let position = monitor.position().to_logical::<f64>(scale);

    json!({
        "name": monitor.name(),
        "position": { "x": position.x, "y": position.y },
        "size": { "width": size.width, "height": size.height },
        "scaleFactor": scale,
        "primary": primary.is_some_and(|other| other == monitor),
    })
}

/// Whether a logical point falls inside a monitor.
fn contains(monitor: &MonitorHandle, x: f64, y: f64) -> bool {
    let scale = monitor.scale_factor();
    let origin = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);

    x >= origin.x && x < origin.x + size.width && y >= origin.y && y < origin.y + size.height
}
