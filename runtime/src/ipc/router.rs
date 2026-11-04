//! Method dispatch.
//!
//! One `match` on the namespace decides *where* a call runs; the namespace
//! module decides *what* it does. Anything that blocks goes to the worker
//! pool, anything that needs the window stays on the event loop thread.

use std::sync::Arc;

use serde_json::Value;

use crate::api;
use crate::error::{ApiError, ApiResult};
use crate::ipc::{Outgoing, Request, Response};
use crate::state::{MainCtx, Runtime};

/// Route one call.
///
/// `Some(response)` means it was answered synchronously. `None` means the
/// work moved elsewhere and the response will arrive later as a
/// [`UserEvent::Outgoing`](crate::ipc::UserEvent::Outgoing).
pub fn dispatch(ctx: &mut MainCtx<'_>, request: Request) -> Option<Response> {
    let Request { id, method, params } = request;
    let namespace = match method.split_once('.') {
        Some((namespace, _)) => namespace.to_string(),
        None => method.clone(),
    };

    let answered = match namespace.as_str() {
        // Blocking work: hand it to the pool and answer later. A keychain read
        // belongs here too - on macOS it can put a prompt in front of the user,
        // and the event loop is what would have to draw it.
        "filesystem" | "secrets" | "hid" | "privacy" => {
            return queue_blocking(ctx, id, namespace, method, params);
        }

        // Starting a process is quick; waiting for it happens on its own
        // thread, so `process.execute` answers later and returns nothing here.
        "process" => api::process::dispatch(ctx, &id, &method, params),
        // A request to a device that is not there takes as long as its
        // timeout, so this answers later too.
        "network" => api::network::dispatch(ctx, &id, &method, params),
        // A query is as slow as it is, and the connection has its own thread,
        // so this answers later too.
        "database" => api::database::dispatch(ctx, &id, &method, params),
        // Discovery waits for devices to answer, so it answers later too.
        "mdns" => api::mdns::dispatch(ctx, &id, &method, params),
        // Downloading an update takes as long as it takes, so it answers later.
        "updater" => crate::updater::dispatch(ctx, &id, &method, params),
        // Rendering a page and waiting on a print dialog takes as long as it
        // takes, so it answers later too.
        "print" => api::print::dispatch(ctx, &id, &method, params),

        // Everything else is either cheap or needs the main thread anyway.
        _ => Some(answer_now(ctx, &namespace, &method, params)),
    };

    match answered {
        Some(result) => Some(Response::from_result(id, result)),
        None => None,
    }
}

/// Run a blocking call on the worker pool, which answers it when it is done.
fn queue_blocking(
    ctx: &MainCtx<'_>,
    id: String,
    namespace: String,
    method: String,
    params: Value,
) -> Option<Response> {
    let rt = ctx.rt.clone();
    let deferred_id = id.clone();
    // The response goes back to the window that asked, not to whichever
    // window happens to be focused when the work finishes.
    let source = ctx.source.to_string();
    let reply_to = source.clone();
    let queued = ctx.pool.execute(move || {
        let result = run_blocking(&rt, &source, &namespace, &method, params);
        rt.send(
            Some(reply_to),
            Outgoing::Response(Response::from_result(deferred_id, result)),
        );
    });
    match queued {
        Ok(()) => None,
        Err(error) => Some(Response::from_result(id, Err(error))),
    }
}

/// The blocking namespaces, on a worker thread.
fn run_blocking(
    rt: &Arc<Runtime>,
    source: &str,
    namespace: &str,
    method: &str,
    params: Value,
) -> ApiResult {
    match namespace {
        "secrets" => api::secrets::dispatch(rt, method, params),
        "hid" => api::hid::dispatch(rt, source, method, params),
        // A privacy request blocks until the user answers the system prompt,
        // which must not wedge the event loop.
        "privacy" => api::privacy::dispatch(rt, method, params),
        _ if method == "filesystem.watch"
            || method == "filesystem.unwatch"
            || method == "filesystem.watches" =>
        {
            api::watch::dispatch(rt, source, method, params)
        }
        _ => api::filesystem::dispatch(rt, method, params),
    }
}

/// The namespaces answered on the event loop, before the next event.
fn answer_now(
    ctx: &mut MainCtx<'_>,
    namespace: &str,
    method: &str,
    params: Value,
) -> ApiResult {
    match namespace {
        "app" => api::app::dispatch(ctx, method, params),
        "window" => api::window::dispatch(ctx, method, params),
        "dialog" => api::dialog::dispatch(ctx, method, params),
        "clipboard" => api::clipboard::dispatch(ctx.rt, method, params),
        "notification" => api::notification::dispatch(ctx.rt, method, params),
        "os" => api::os::dispatch(ctx.rt, method, params),
        "deeplink" => api::deeplink::dispatch(ctx.rt, method, params),
        "shell" => api::shell::dispatch(ctx.rt, method, params),
        "menu" => api::menu::dispatch(ctx, method, params),
        "tray" => api::tray::dispatch(ctx, method, params),
        "screen" => api::screen::dispatch(ctx, method, params),
        "sharedState" => api::shared_state::dispatch(ctx, method, params),
        "shortcut" => api::shortcut::dispatch(ctx, method, params),
        "autostart" => api::autostart::dispatch(ctx.rt, method, params),
        "bridge" => crate::webview::dispatch(ctx.rt, method, params),
        _ => Err(ApiError::unknown_method(method)),
    }
}
