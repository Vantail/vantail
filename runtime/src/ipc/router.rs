//! Method dispatch.
//!
//! One `match` on the namespace decides *where* a call runs; the namespace
//! module decides *what* it does. Anything that blocks goes to the worker
//! pool, anything that needs the window stays on the event loop thread.

use crate::api;
use crate::error::ApiError;
use crate::ipc::{Outgoing, Request, Response};
use crate::state::MainCtx;

/// Route one call.
///
/// `Some(response)` means it was answered synchronously. `None` means the
/// work moved to the pool and the response will arrive later as a
/// [`UserEvent::Outgoing`](crate::ipc::UserEvent::Outgoing).
pub fn dispatch(ctx: &mut MainCtx<'_>, request: Request) -> Option<Response> {
    let Request { id, method, params } = request;
    let namespace = method.split('.').next().unwrap_or_default().to_string();

    // Blocking work: hand it to the pool and answer later. A keychain read
    // belongs here too - on macOS it can put a prompt in front of the user,
    // and the event loop is what would have to draw it.
    if namespace == "filesystem" || namespace == "secrets" || namespace == "hid" {
        let rt = ctx.rt.clone();
        let deferred_id = id.clone();
        // The response goes back to the window that asked, not to whichever
        // window happens to be focused when the work finishes.
        let source = ctx.source.to_string();
        let reply_to = source.clone();
        let queued = ctx.pool.execute(move || {
            let result = match namespace.as_str() {
                "secrets" => api::secrets::dispatch(&rt, &method, params),
                "hid" => api::hid::dispatch(&rt, &source, &method, params),
                _ if method == "filesystem.watch"
                    || method == "filesystem.unwatch"
                    || method == "filesystem.watches" =>
                {
                    api::watch::dispatch(&rt, &source, &method, params)
                }
                _ => api::filesystem::dispatch(&rt, &method, params),
            };
            rt.send(
                Some(reply_to),
                Outgoing::Response(Response::from_result(deferred_id, result)),
            );
        });
        return match queued {
            Ok(()) => None,
            Err(error) => Some(Response::from_result(id, Err(error))),
        };
    }

    // Starting a process is quick; waiting for it happens on its own thread,
    // so `process.execute` answers later and returns nothing here.
    if namespace == "process" {
        return api::process::dispatch(ctx, &id, &method, params)
            .map(|result| Response::from_result(id, result));
    }

    // A request to a device that is not there takes as long as its timeout,
    // so this answers later too.
    if namespace == "network" {
        return api::network::dispatch(ctx, &id, &method, params)
            .map(|result| Response::from_result(id, result));
    }

    // A query is as slow as it is, and the connection has its own thread, so
    // this answers later too.
    if namespace == "database" {
        return api::database::dispatch(ctx, &id, &method, params)
            .map(|result| Response::from_result(id, result));
    }

    // Discovery waits for devices to answer, so it answers later too.
    if namespace == "mdns" {
        return api::mdns::dispatch(ctx, &id, &method, params)
            .map(|result| Response::from_result(id, result));
    }

    // Downloading an update takes as long as it takes, so it answers later.
    if namespace == "updater" {
        return crate::updater::dispatch(ctx, &id, &method, params)
            .map(|result| Response::from_result(id, result));
    }

    // Everything else is either cheap or needs the main thread anyway.
    let result = match namespace.as_str() {
        "app" => api::app::dispatch(ctx, &method, params),
        "window" => api::window::dispatch(ctx, &method, params),
        "dialog" => api::dialog::dispatch(ctx, &method, params),
        "clipboard" => api::clipboard::dispatch(ctx.rt, &method, params),
        "notification" => api::notification::dispatch(ctx.rt, &method, params),
        "os" => api::os::dispatch(ctx.rt, &method, params),
        "deeplink" => api::deeplink::dispatch(ctx.rt, &method, params),
        "shell" => api::shell::dispatch(ctx.rt, &method, params),
        "menu" => api::menu::dispatch(ctx, &method, params),
        "tray" => api::tray::dispatch(ctx, &method, params),
        "screen" => api::screen::dispatch(ctx, &method, params),
        "shortcut" => api::shortcut::dispatch(ctx, &method, params),
        "autostart" => api::autostart::dispatch(ctx.rt, &method, params),
        _ => Err(ApiError::unknown_method(&method)),
    };

    Some(Response::from_result(id, result))
}
