//! `network.*` - an HTTP client that is not the webview's.
//!
//! The application's own `fetch` handles the internet perfectly well, and
//! should be used for it. What it cannot do is talk to the hardware on the
//! user's network: a smart-home hub answers HTTPS with a self-signed certificate,
//! and a smart light, a desk display or a single-board computer sends no CORS
//! headers at all. Neither is something an application can work around, and
//! neither is a reason to ship a Node runtime.
//!
//! So this is a capability, not a convenience: it exists for the requests a
//! browser refuses to make, and every one of them is checked against
//! `permissions.network` first - including each hop of a redirect, because a
//! permitted host that redirects to a denied one is otherwise a way straight
//! through the fence.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use ureq::http;

use crate::error::{ApiError, ApiResult};
use crate::ipc::{Event, Outgoing, Request, Response, UserEvent};
use crate::lock::lock;
use crate::permissions::network::{CertificatePaths, Endpoint};
use crate::read::filled;
use crate::state::{MainCtx, Runtime};

const BASE64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// A buffered response has to fit in a JSON string on its way to the webview,
/// so there is a ceiling. Generous for an API call, far too small for a video
/// - which is what `network.stream` is for.
///
/// Documented in `docs/api.md`, because a body one byte over this is an error
/// rather than a truncation, and a caller should know the number.
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

/// How much of a stream to carry in one event. Big enough that a download
/// does not drown the IPC channel in messages, small enough that an SSE event
/// is delivered as soon as it arrives rather than when the buffer fills.
const CHUNK: usize = 64 * 1024;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_MAX_REDIRECTS: u32 = 5;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestParams {
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    /// Sent as UTF-8.
    #[serde(default)]
    body: Option<String>,
    /// Sent as raw bytes. Wins over `body` if both are given.
    #[serde(default)]
    body_base64: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    max_redirects: Option<u32>,
    #[serde(default)]
    redirect: Redirect,
    /// `text` (default) or `base64`.
    #[serde(default)]
    response_type: Option<String>,
}

impl RequestParams {
    fn timeout(&self) -> Duration {
        match self.timeout_ms {
            Some(timeout_ms) => Duration::from_millis(timeout_ms),
            None => Duration::from_millis(DEFAULT_TIMEOUT_MS),
        }
    }

    fn allowed_hops(&self) -> u32 {
        match self.max_redirects {
            Some(hops) => hops,
            None => DEFAULT_MAX_REDIRECTS,
        }
    }
}

/// What a 3xx with a `Location` does, named and meaning what `fetch`'s
/// `redirect` option does.
#[derive(Deserialize, Default, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum Redirect {
    /// Follow it, up to `maxRedirects`, checking every hop.
    #[default]
    Follow,
    /// Stop at it and answer with the 3xx itself - status, `Location`,
    /// `Set-Cookie` and all. What an API client needs to test a redirect, and
    /// what `fetch` in a page cannot give: there a manual redirect comes back
    /// opaque, with no status and no headers.
    Manual,
    /// Refuse it, so a request that must not be redirected cannot be.
    Error,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelParams {
    /// The id of the `network.request` message being abandoned.
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamIdParams {
    id: u32,
}

fn default_method() -> String {
    "GET".to_string()
}

// ---------------------------------------------------------------------------
// What is still running
// ---------------------------------------------------------------------------

/// One request that has not answered yet.
pub(crate) struct Entry {
    /// Read between redirect hops and between chunks. Setting it cannot
    /// interrupt a read that is already blocked - see `InFlight`.
    cancelled: Arc<AtomicBool>,
    /// The window that asked, so the reply goes there even when some other
    /// window is what cancelled it.
    pub(crate) window: String,
}

/// Requests and streams that have not finished yet.
///
/// For a request, the entry is the right to answer: whoever removes it sends
/// the response, so a cancel and a request finishing at the same moment
/// cannot both reply to the same id.
///
/// Cancelling rejects the caller's promise immediately, but it does not
/// unblock the thread doing the work: `ureq` gives no way to interrupt a
/// socket read in progress, so a cancelled request keeps its slot in the
/// network pool until its current hop finishes or `timeoutMs` expires. That
/// is the right trade for a stop button, since the user gets their UI back at
/// once, but it does mean a run of cancelled requests to a black-holing host
/// can occupy the pool for up to `timeoutMs`.
#[derive(Default)]
pub struct InFlight {
    live: Mutex<HashMap<String, Entry>>,
    /// Streams, by the id handed to the application. They share the flag of
    /// the request that opened them, so one `cancel` covers both phases.
    streams: Mutex<HashMap<u32, Arc<AtomicBool>>>,
    next_stream: AtomicU32,
}

impl InFlight {
    pub(crate) fn register(&self, id: &str, window: &str) -> Arc<AtomicBool> {
        let cancelled = Arc::new(AtomicBool::new(false));
        lock(&self.live).insert(
            id.to_string(),
            Entry {
                cancelled: Arc::clone(&cancelled),
                window: window.to_string(),
            },
        );
        cancelled
    }

    /// Take the right to answer this id. `None` means somebody already did.
    pub(crate) fn claim(&self, id: &str) -> Option<Entry> {
        lock(&self.live).remove(id)
    }

    fn open_stream(&self, cancelled: Arc<AtomicBool>) -> u32 {
        let id = self.next_stream.fetch_add(1, Ordering::Relaxed) + 1;
        lock(&self.streams).insert(id, cancelled);
        id
    }

    fn close_stream(&self, id: u32) {
        lock(&self.streams).remove(&id);
    }

    fn cancel_stream(&self, id: u32) -> bool {
        match lock(&self.streams).remove(&id) {
            Some(cancelled) => {
                cancelled.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

pub fn dispatch(ctx: &mut MainCtx<'_>, id: &str, method: &str, params: Value) -> Option<ApiResult> {
    match method {
        "network.request" => start(ctx, id, params),
        "network.stream" => start_stream(ctx, id, params),
        "network.cancel" => Some(cancel(ctx, params)),
        "network.cancelStream" => Some(cancel_stream(ctx, params)),
        // A second protocol, but the same namespace and the same permission.
        "network.socket" | "network.socketSend" | "network.socketClose" => {
            crate::api::websocket::dispatch(ctx, id, method, params)
        }
        _ => Some(Err(ApiError::unknown_method(method))),
    }
}

/// Queue a buffered request. Returns `None`: the reply comes from the worker.
fn start(ctx: &mut MainCtx<'_>, id: &str, params: Value) -> Option<ApiResult> {
    let rt = ctx.rt.clone();
    let request_id = id.to_string();
    let cancelled = rt.requests.register(id, ctx.source);

    // Queued on the network pool rather than the filesystem one: a device
    // that has gone away takes the full timeout to say so, and should not
    // hold up a file read while it does.
    let queued = ctx.network.execute(move || {
        let result = perform(&rt, params, &cancelled);
        // Whoever claims the id owns the reply. If a cancel got here first it
        // has already answered, and this response is dropped on the floor.
        if let Some(entry) = rt.requests.claim(&request_id) {
            rt.send(
                Some(entry.window),
                Outgoing::Response(Response::from_result(request_id, result)),
            );
        }
    });

    match queued {
        Ok(()) => None,
        Err(error) => {
            // Nothing will run, so nothing will answer later. Give the id back
            // rather than leaving an entry that can never be claimed.
            let _ = ctx.rt.requests.claim(id);
            Some(Err(error))
        }
    }
}

/// Open a streaming request.
///
/// On its own thread rather than the network pool: a server-sent event stream
/// stays open for as long as the application wants it, and a fixed pool would
/// be starved by two of them.
fn start_stream(ctx: &mut MainCtx<'_>, id: &str, params: Value) -> Option<ApiResult> {
    let rt = ctx.rt.clone();
    let request_id = id.to_string();
    let window = ctx.source.to_string();
    let cancelled = rt.requests.register(id, ctx.source);

    let spawned = std::thread::Builder::new()
        .name(format!("vantail-stream-{id}"))
        .spawn(move || run_stream(rt, window, request_id, params, cancelled));

    match spawned {
        Ok(_) => None,
        Err(error) => {
            let _ = ctx.rt.requests.claim(id);
            Some(Err(ApiError::internal(format!(
                "Could not start a thread for the stream: {error}"
            ))))
        }
    }
}

/// Abandon a request that has not answered yet.
fn cancel(ctx: &mut MainCtx<'_>, params: Value) -> ApiResult {
    let CancelParams { id } = Request::params("network.cancel", params)?;

    // Cancelling something that has already answered is the ordinary race,
    // not an error: the caller's promise is simply already settled.
    let Some(entry) = ctx.rt.requests.claim(&id) else {
        return Ok(json!(false));
    };

    // Read between hops, so a multi-hop redirect stops as soon as it can.
    entry.cancelled.store(true, Ordering::SeqCst);
    ctx.rt.send(
        Some(entry.window),
        Outgoing::Response(Response::from_result(
            id,
            Err(ApiError::cancelled("The request was cancelled")),
        )),
    );
    Ok(json!(true))
}

/// Stop a stream that is already delivering.
fn cancel_stream(ctx: &mut MainCtx<'_>, params: Value) -> ApiResult {
    let StreamIdParams { id } = Request::params("network.cancelStream", params)?;
    Ok(json!(ctx.rt.requests.cancel_stream(id)))
}

// ---------------------------------------------------------------------------
// Doing the work
// ---------------------------------------------------------------------------

fn perform(rt: &Arc<Runtime>, params: Value, cancelled: &AtomicBool) -> ApiResult {
    let params: RequestParams = Request::params("network.request", params)?;
    let binary = wants_bytes(params.response_type.as_deref())?;

    let mut negotiated = negotiate(rt, &params, cancelled)?;

    let download = Instant::now();
    let url = &negotiated.url;
    let bytes = negotiated
        .body
        .with_config()
        .limit(MAX_RESPONSE_BYTES as u64)
        .read_to_vec()
        .map_err(|e| {
            ApiError::new(
                crate::error::code::IO_ERROR,
                format!("Could not read the response from `{url}`: {e}"),
            )
        })?;

    Ok(render(negotiated, bytes, binary, download.elapsed()))
}

/// Negotiate the request, then hand every chunk to the window as it arrives.
fn run_stream(
    rt: Arc<Runtime>,
    window: String,
    request_id: String,
    params: Value,
    cancelled: Arc<AtomicBool>,
) {
    let (negotiated, binary) = match negotiate_stream(&rt, params, &cancelled) {
        Ok(started) => started,
        Err(error) => {
            // The head never arrived. Answer the original call with why, if a
            // cancel has not already answered it.
            if let Some(entry) = rt.requests.claim(&request_id) {
                rt.send(
                    Some(entry.window),
                    Outgoing::Response(Response::from_result(request_id, Err(error))),
                );
            }
            return;
        }
    };
    let stream_id = rt.requests.open_stream(Arc::clone(&cancelled));

    let Negotiated {
        url,
        head,
        body,
        redirects,
        started,
    } = negotiated;

    // Claiming the id is what makes this the answer. A cancel that got here
    // first has already rejected the call, so there is nothing to stream to.
    if rt.requests.claim(&request_id).is_none() {
        rt.requests.close_stream(stream_id);
        return;
    }

    rt.send(
        Some(window.clone()),
        Outgoing::Response(Response::from_result(
            request_id,
            Ok(Value::Object(head_json(
                stream_id, &url, &head, redirects, started,
            ))),
        )),
    );

    let forwarded = forward_chunks(
        &rt,
        &window,
        stream_id,
        binary,
        body.into_reader(),
        &cancelled,
    );
    let failure = match forwarded {
        Ok(()) => None,
        Err(error) => Some(format!("Could not read the stream from `{url}`: {error}")),
    };

    let was_cancelled = cancelled.load(Ordering::SeqCst);
    rt.requests.close_stream(stream_id);
    rt.send(
        Some(window),
        Outgoing::Event(Event::new(
            "network.end",
            json!({
                "id": stream_id,
                "cancelled": was_cancelled,
                "error": failure,
            }),
        )),
    );
}

/// Negotiate a stream's request, as far as its response head. Answers with
/// whether the chunks are to be sent as bytes.
fn negotiate_stream(
    rt: &Arc<Runtime>,
    params: Value,
    cancelled: &AtomicBool,
) -> Result<(Negotiated, bool), ApiError> {
    let params: RequestParams = Request::params("network.stream", params)?;
    let binary = wants_bytes(params.response_type.as_deref())?;
    let negotiated = negotiate(rt, &params, cancelled)?;
    Ok((negotiated, binary))
}

/// Hand the body to the window a chunk at a time, until it ends, fails to
/// read, or the stream is cancelled.
fn forward_chunks(
    rt: &Runtime,
    window: &str,
    stream_id: u32,
    binary: bool,
    mut reader: impl Read,
    cancelled: &AtomicBool,
) -> std::io::Result<()> {
    let mut buffer = vec![0_u8; CHUNK];
    let mut carry: Vec<u8> = Vec::new();

    while !cancelled.load(Ordering::SeqCst) {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(());
        }
        let chunk = filled(&buffer, read);
        let data = if binary {
            BASE64.encode(chunk)
        } else {
            decode_text(&mut carry, chunk)
        };
        // A chunk that was nothing but the start of a character the next
        // chunk finishes has nothing to deliver yet.
        if data.is_empty() {
            continue;
        }
        rt.send(
            Some(window.to_string()),
            Outgoing::Event(Event::new(
                "network.chunk",
                json!({ "id": stream_id, "data": data }),
            )),
        );
    }
    Ok(())
}

/// The request, its redirects, and the response head - stopping before the
/// body is read, so a buffered call and a stream can share all of it.
struct Negotiated {
    url: String,
    head: Head,
    body: ureq::Body,
    redirects: Vec<Value>,
    started: Instant,
}

/// The request as it goes out on the current hop. A redirect changes it for
/// the next one.
struct Outbound {
    method: String,
    url: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

impl Outbound {
    fn new(params: &RequestParams) -> Result<Self, ApiError> {
        let body = match (&params.body_base64, &params.body) {
            (Some(encoded), _) => BASE64.decode(encoded.as_bytes()).map_err(|e| {
                ApiError::invalid_params(format!("`bodyBase64` is not valid base64: {e}"))
            })?,
            (None, Some(text)) => text.as_bytes().to_vec(),
            (None, None) => Vec::new(),
        };
        Ok(Outbound {
            method: params.method.to_ascii_uppercase(),
            url: params.url.clone(),
            headers: params.headers.clone(),
            body,
        })
    }

    /// Point the request where a redirect sent it.
    fn follow(&mut self, status: http::StatusCode, location: String) {
        // 303, and 301/302 in practice, turn everything into a GET.
        if status.as_u16() != 307 && status.as_u16() != 308 {
            self.method = "GET".to_string();
            self.body.clear();
            self.headers
                .retain(|name, _| !name.eq_ignore_ascii_case("content-type"));
        }
        self.url = location;
    }
}

fn negotiate(
    rt: &Arc<Runtime>,
    params: &RequestParams,
    cancelled: &AtomicBool,
) -> Result<Negotiated, ApiError> {
    let mut request = Outbound::new(params)?;
    let timeout = params.timeout();
    let allowed_hops = params.allowed_hops();

    let mut previous: Option<Endpoint> = None;
    // Every hop that redirected, in the order they were followed. Discarding
    // these is how "which redirect dropped my auth header" becomes
    // unanswerable, so they are kept.
    let mut redirects: Vec<Value> = Vec::new();
    let started = Instant::now();

    for _ in 0..=allowed_hops {
        if cancelled.load(Ordering::SeqCst) {
            return Err(ApiError::cancelled("The request was cancelled"));
        }

        // Every hop, not just the first. This is the whole reason redirects
        // are followed here rather than by the HTTP client.
        let endpoint = authorise(rt, &request.url)?;

        let crossed_hosts = match &previous {
            Some(previous) => previous.host != endpoint.host,
            None => false,
        };
        if crossed_hosts {
            let dropped = drop_credentials(&mut request.headers);
            record_dropped(&mut redirects, dropped);
        }

        let (head, received) = send_hop(rt, &endpoint, &request, timeout)?;

        let status = head.status;
        // A 3xx without a `Location` - a 304, say - is not a redirect, and is
        // an answer like any other status.
        let location = if status.is_redirection() {
            redirect_target(&head, &request.url)
        } else {
            None
        };
        let Some(location) = location else {
            return Ok(Negotiated {
                url: request.url,
                head,
                body: received,
                redirects,
                started,
            });
        };
        // The header as sent, which may be relative; `url` on the next hop is
        // where it actually resolved to.
        let sent_location = match head.headers.get("location") {
            Some(location) => location.clone(),
            None => String::new(),
        };

        match params.redirect {
            // The 3xx is the answer. Nothing further is requested, so there is
            // no further host to authorise either.
            Redirect::Manual => {
                return Ok(Negotiated {
                    url: request.url,
                    head,
                    body: received,
                    redirects,
                    started,
                })
            }
            Redirect::Error => return Err(redirect_refused(&request.url, &head, &sent_location)),
            Redirect::Follow => {}
        }

        redirects.push(followed(&request.url, &head, &sent_location));
        request.follow(status, location);
        previous = Some(endpoint);
    }

    Err(too_many_redirects(&params.url, allowed_hops, redirects))
}

/// Browsers drop credentials when a redirect crosses origins, and so does
/// this: a redirect must not be able to hand an API token to somebody else.
/// Answers with the names of the headers it dropped.
fn drop_credentials(headers: &mut BTreeMap<String, String>) -> Vec<String> {
    let mut dropped: Vec<String> = Vec::new();
    headers.retain(|name, _| {
        let lower = name.to_ascii_lowercase();
        let keep = lower != "authorization" && lower != "cookie" && lower != "proxy-authorization";
        if !keep {
            dropped.push(lower);
        }
        keep
    });
    dropped
}

/// Reported on the hop that caused it, so the answer to "which one dropped my
/// auth header" is in the record rather than inferred.
fn record_dropped(redirects: &mut [Value], dropped: Vec<String>) {
    if dropped.is_empty() {
        return;
    }
    if let Some(last) = redirects.last_mut() {
        last["droppedHeaders"] = json!(dropped);
    }
}

/// Send one hop of the request, with whatever the config says about the
/// host it goes to.
fn send_hop(
    rt: &Runtime,
    endpoint: &Endpoint,
    request: &Outbound,
    timeout: Duration,
) -> Result<(Head, ureq::Body), ApiError> {
    let insecure = rt.permissions.network.allows_invalid_certificate(endpoint);
    // Both are looked up per hop rather than once: a redirect to another host
    // must get that host's certificate and that host's proxy, not the ones the
    // first hop happened to match.
    let certificate = match rt.permissions.network.client_certificate(endpoint) {
        Some(paths) => Some(client_certificate(paths)?),
        None => None,
    };
    let proxy = rt.permissions.network.proxy(endpoint);
    open(request, timeout, insecure, certificate, proxy)
}

/// What a followed redirect said, for `redirects[]`.
fn followed(url: &str, head: &Head, location: &str) -> Value {
    json!({
        "status": head.status.as_u16(),
        "url": url,
        "location": location,
        // Everything the hop said, not just where it pointed: a `Set-Cookie`
        // on a redirect - a login answering 302 - is often the very thing the
        // caller is after.
        "headerPairs": &head.pairs,
        "droppedHeaders": Vec::<String>::new(),
    })
}

/// `redirect: "error"`, and the server redirected.
fn redirect_refused(url: &str, head: &Head, location: &str) -> ApiError {
    let status = head.status.as_u16();
    ApiError::new(
        crate::error::code::REDIRECT_REFUSED,
        format!(
            "`{url}` answered {status} with a redirect to `{location}`, and \
             `redirect: \"error\"` refuses to follow one"
        ),
    )
    .with_data(json!({
        "status": status,
        "url": url,
        "location": location,
        "headerPairs": &head.pairs,
    }))
}

/// Out of hops. Not a transport failure, so not `IO_ERROR`: the redirects
/// followed so far, the last of them the one that was not, go with it.
fn too_many_redirects(url: &str, allowed_hops: u32, redirects: Vec<Value>) -> ApiError {
    ApiError::new(
        crate::error::code::TOO_MANY_REDIRECTS,
        format!(
            "`{url}` redirected more than {allowed_hops} {}",
            if allowed_hops == 1 { "time" } else { "times" }
        ),
    )
    .with_data(json!({ "redirects": redirects }))
}

/// One prompt at a time.
///
/// A page that fires five requests at a new host at once should ask the user
/// once, not five times - and the four that were waiting should find the
/// answer already given rather than ask again.
static PROMPT: OnceLock<Mutex<()>> = OnceLock::new();

/// Ask the user about a host the config did not name.
///
/// The dialog is the authorisation, exactly as `filesystem.grantFromDialog`
/// treats the user picking a file: an application that has to reach a host
/// nobody could have listed at build time can still be written, and a page
/// that has been taken over still cannot reach an attacker's server without a
/// person reading its name and agreeing.
pub(crate) fn authorise(rt: &Arc<Runtime>, url: &str) -> Result<Endpoint, ApiError> {
    match rt.permissions.network.check(url) {
        Ok(endpoint) => Ok(endpoint),
        // A host the config never named. If the application asked to be able
        // to reach hosts its user chooses, the user gets to choose.
        Err(denial) => ask_to_grant(rt, url, denial),
    }
}

fn ask_to_grant(rt: &Arc<Runtime>, url: &str, denial: ApiError) -> Result<Endpoint, ApiError> {
    let Some(endpoint) = rt.permissions.network.promptable(url) else {
        return Err(denial);
    };

    let _serialised = lock(PROMPT.get_or_init(Mutex::default));

    // Somebody may have been granted this host while we waited our turn.
    if let Ok(endpoint) = rt.permissions.network.check(url) {
        return Ok(endpoint);
    }

    let (answer, reply) = std::sync::mpsc::channel();
    let asked = rt.proxy().send_event(UserEvent::GrantHost {
        host: endpoint.host.clone(),
        app: rt.config.app.name.clone(),
        answer,
    });
    if asked.is_err() {
        // The event loop has gone, which means the application is shutting
        // down. Nobody is there to ask.
        return Err(denial);
    }

    // A closed channel means the loop exited before answering, which is a no.
    if matches!(reply.recv(), Ok(true)) {
        rt.permissions.network.grant(&endpoint.host);
        Ok(endpoint)
    } else {
        Err(denial)
    }
}

fn wants_bytes(response_type: Option<&str>) -> Result<bool, ApiError> {
    match response_type {
        None | Some("text") => Ok(false),
        Some("base64") => Ok(true),
        Some(other) => Err(ApiError::invalid_params(format!(
            "`responseType` must be \"text\" or \"base64\", not \"{other}\""
        ))),
    }
}

/// A response, up to but not including its body.
struct Head {
    status: http::StatusCode,
    headers: BTreeMap<String, String>,
    /// Every header line in the order it arrived, repeats intact.
    ///
    /// `Set-Cookie` is the header that is legitimately repeated and the one
    /// where joining is ambiguous, because an `Expires` date contains the
    /// separator. A record cannot represent it; this can.
    pairs: Vec<(String, String)>,
    /// How long this request took to become readable.
    elapsed: Duration,
}

// ---------------------------------------------------------------------------
// The HTTP client
// ---------------------------------------------------------------------------

/// Client certificates, parsed once and kept by the files they came from.
///
/// Loaded on first use rather than at startup: a certificate under `$APPDATA`
/// may not be provisioned until the user does it, and an application that
/// will not launch is a worse failure than a request that will not send.
static CERTIFICATES: OnceLock<Mutex<HashMap<(PathBuf, PathBuf), ureq::tls::ClientCert>>> =
    OnceLock::new();

fn client_certificate(paths: &CertificatePaths) -> Result<ureq::tls::ClientCert, ApiError> {
    let cache = CERTIFICATES.get_or_init(Mutex::default);
    let key = (paths.certificate.clone(), paths.key.clone());

    if let Some(found) = lock(cache).get(&key) {
        return Ok(found.clone());
    }

    let certificate_pem = std::fs::read(&paths.certificate).map_err(|e| {
        ApiError::io(
            &format!(
                "Could not read the client certificate `{}`",
                paths.certificate.display()
            ),
            e,
        )
    })?;
    let key_pem = std::fs::read(&paths.key).map_err(|e| {
        ApiError::io(
            &format!("Could not read the client key `{}`", paths.key.display()),
            e,
        )
    })?;

    // The whole chain, not only the leaf: a missing intermediate is usually
    // what a server is complaining about when it rejects an otherwise valid
    // certificate.
    let mut chain = Vec::new();
    for item in ureq::tls::parse_pem(&certificate_pem) {
        if let Ok(ureq::tls::PemItem::Certificate(certificate)) = item {
            chain.push(certificate);
        }
    }
    if chain.is_empty() {
        return Err(ApiError::invalid_params(format!(
            "`{}` holds no PEM certificate",
            paths.certificate.display()
        )));
    }

    let private_key = ureq::tls::PrivateKey::from_pem(&key_pem).map_err(|e| {
        ApiError::invalid_params(format!(
            "`{}` is not a PEM private key: {e}",
            paths.key.display()
        ))
    })?;

    let certificate = ureq::tls::ClientCert::new_with_certs(&chain, private_key);
    lock(cache).insert(key, certificate.clone());
    Ok(certificate)
}

/// Send one request and read its head, leaving the body unread.
fn open(
    request: &Outbound,
    timeout: Duration,
    insecure: bool,
    certificate: Option<ureq::tls::ClientCert>,
    proxy: Option<&str>,
) -> Result<(Head, ureq::Body), ApiError> {
    let agent = agent(timeout, insecure, certificate, proxy)?;

    let mut builder = http::Request::builder()
        .method(request.method.as_str())
        .uri(request.url.as_str());
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }

    let built = builder.body(request.body.clone()).map_err(|e| {
        // A bad method, a bad URL, or a header value with a newline in it.
        ApiError::invalid_params(format!("Could not build the request: {e}"))
    })?;

    let started = Instant::now();
    let response = agent
        .run(built)
        .map_err(|e| ApiError::new(crate::error::code::IO_ERROR, describe(&request.url, &e)))?;
    // `run` returns once the head is readable; the body is still streaming.
    let elapsed = started.elapsed();

    Ok(read_head(response, elapsed))
}

/// An HTTP client for one hop, set up the way that hop's host needs.
fn agent(
    timeout: Duration,
    insecure: bool,
    certificate: Option<ureq::tls::ClientCert>,
    proxy: Option<&str>,
) -> Result<ureq::Agent, ApiError> {
    let tls = ureq::tls::TlsConfig::builder()
        .disable_verification(insecure)
        .client_cert(certificate)
        .build();

    let mut config = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        // Redirects are followed by hand, so each hop can be checked.
        .max_redirects(0)
        .max_redirects_will_error(false)
        // A 404 is an answer, not a transport failure; the caller wants the
        // status rather than an exception.
        .http_status_as_error(false)
        .tls_config(tls);

    if let Some(url) = proxy {
        let proxy = ureq::Proxy::new(url).map_err(|e| {
            ApiError::invalid_params(format!(
                "`permissions.network.proxy.url` (`{url}`) is not a usable proxy: {e}"
            ))
        })?;
        config = config.proxy(Some(proxy));
    }

    Ok(config.build().into())
}

/// The response's head, and its body still unread.
fn read_head(response: http::Response<ureq::Body>, elapsed: Duration) -> (Head, ureq::Body) {
    let status = response.status();
    let mut collected = BTreeMap::new();
    let mut pairs = Vec::new();
    for (name, value) in response.headers() {
        let text = match value.to_str() {
            Ok(text) => text.to_string(),
            Err(_) => String::new(),
        };
        let name = name.as_str().to_ascii_lowercase();
        pairs.push((name.clone(), text.clone()));
        collected
            .entry(name)
            .and_modify(|existing: &mut String| {
                // Repeated headers - Set-Cookie, mostly - are joined the way
                // the fetch spec joins them. Lossy for Set-Cookie, which is
                // exactly why `pairs` is kept beside this.
                existing.push_str(", ");
                existing.push_str(&text);
            })
            .or_insert(text);
    }

    let head = Head {
        status,
        headers: collected,
        pairs,
        elapsed,
    };
    (head, response.into_body())
}

/// A path up to and including its last `/`, or `/` when it has none.
fn directory_of(path: &str) -> &str {
    let Some(at) = path.rfind('/') else {
        return "/";
    };
    match path.get(..=at) {
        Some(directory) => directory,
        None => "/",
    }
}

fn redirect_target(head: &Head, base: &str) -> Option<String> {
    let location = head.headers.get("location")?;
    Some(resolve(base, location))
}

/// Resolve a `Location` header against the URL it came from.
///
/// Only the three forms a real server sends: absolute, root-relative, and
/// path-relative.
fn resolve(base: &str, location: &str) -> String {
    if location.contains("://") {
        return location.to_string();
    }

    let (scheme, rest) = match base.split_once("://") {
        Some(parts) => parts,
        None => ("http", base),
    };
    let authority = match rest.split(['/', '?', '#']).next() {
        Some(authority) => authority,
        None => rest,
    };
    let origin = format!("{scheme}://{authority}");

    if location.starts_with('/') {
        return format!("{origin}{location}");
    }

    let path = match rest.strip_prefix(authority) {
        Some(path) => path,
        None => "",
    };
    format!("{origin}{}{location}", directory_of(path))
}

/// Decode a chunk as UTF-8, keeping back the start of a character the next
/// chunk will finish.
///
/// Without this a multi-byte character that straddles a chunk boundary comes
/// out as replacement characters - which in a stream of JSON events means a
/// parse error in the middle of a connection that is working perfectly well.
fn decode_text(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);

    match std::str::from_utf8(carry) {
        Ok(text) => {
            let text = text.to_string();
            carry.clear();
            text
        }
        Err(error) => {
            // Split where decoding stopped: what came before is text, and what
            // comes after stays in `carry`.
            let mut rest = carry.split_off(error.valid_up_to());
            let mut text = String::from_utf8_lossy(carry).into_owned();

            *carry = match error.error_len() {
                // Genuinely invalid bytes, not a truncated tail: mark them and
                // carry on, rather than holding them forever.
                Some(bad) => {
                    text.push('\u{FFFD}');
                    rest.split_off(bad)
                }
                // The tail is the start of a character still on the wire.
                None => rest,
            };
            text
        }
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

fn render(negotiated: Negotiated, body: Vec<u8>, binary: bool, download: Duration) -> Value {
    // The body has been read into `body` by now; what is left is the head and
    // the record of how it was reached.
    let Negotiated {
        url,
        head,
        redirects,
        started,
        ..
    } = negotiated;
    let bytes = body.len();
    let (body, encoding) = if binary {
        (BASE64.encode(&body), "base64")
    } else {
        // Lossy on purpose: a text response that is not UTF-8 gets U+FFFD
        // rather than an error. `bodyBytes` and `network.binary` are how a
        // caller that cares tells the difference.
        (String::from_utf8_lossy(&body).into_owned(), "text")
    };

    let total = started.elapsed();
    // The whole call up to the first byte of the final response, which is
    // everything except reading that response's body.
    let ttfb = total.saturating_sub(download);

    let mut object = head_json(0, &url, &head, redirects, started);
    object.remove("id");
    object.insert("body".into(), json!(body));
    object.insert("encoding".into(), json!(encoding));
    // The body as the runtime received it, after any transfer or content
    // decoding - `ureq` inflates gzip before we see it. Exact, unlike
    // `body.length` in JavaScript, which counts UTF-16 code units.
    object.insert("bodyBytes".into(), json!(bytes));
    object.insert(
        "timing".into(),
        json!({
            "ttfbMs": millis(ttfb),
            "headMs": millis(head.elapsed),
            "downloadMs": millis(download),
            "totalMs": millis(total),
        }),
    );
    Value::Object(object)
}

/// Everything known before the body: shared by a buffered response and the
/// opening answer of a stream.
fn head_json(
    stream_id: u32,
    url: &str,
    head: &Head,
    redirects: Vec<Value>,
    started: Instant,
) -> serde_json::Map<String, Value> {
    let status = head.status.as_u16();
    let mut object = serde_json::Map::new();
    object.insert("id".into(), json!(stream_id));
    object.insert("url".into(), json!(url));
    object.insert("status".into(), json!(status));
    object.insert(
        "statusText".into(),
        json!(match head.status.canonical_reason() {
            Some(reason) => reason,
            None => "",
        }),
    );
    object.insert("ok".into(), json!((200..300).contains(&status)));
    object.insert("headers".into(), json!(head.headers));
    object.insert("headerPairs".into(), json!(head.pairs));
    object.insert("redirects".into(), json!(redirects));
    object.insert(
        "timing".into(),
        json!({
            "ttfbMs": millis(started.elapsed()),
            "headMs": millis(head.elapsed),
        }),
    );
    object
}

/// Milliseconds with a fraction, since a LAN device often answers in under
/// one and rounding those all to zero makes the numbers useless.
fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

/// Turn a transport failure into something worth reading.
fn describe(url: &str, error: &ureq::Error) -> String {
    let text = error.to_string();
    if text.contains("certificate") || text.contains("Tls") || text.contains("tls") {
        return format!(
            "Could not reach `{url}`: {text}. If this is a device on your own network with a \
             self-signed certificate, add its host to `permissions.network.allowInvalidCertificates`."
        );
    }
    format!("Could not reach `{url}`: {text}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absolute_location_is_used_as_is() {
        assert_eq!(
            resolve("https://a.example/x", "https://b.example/y"),
            "https://b.example/y"
        );
    }

    #[test]
    fn a_root_relative_location_keeps_the_origin() {
        assert_eq!(
            resolve("https://a.example/deep/path?q=1", "/other"),
            "https://a.example/other"
        );
    }

    #[test]
    fn a_path_relative_location_resolves_against_the_directory() {
        assert_eq!(
            resolve("https://a.example/deep/path", "sibling"),
            "https://a.example/deep/sibling"
        );
        assert_eq!(
            resolve("https://a.example/top", "next"),
            "https://a.example/next"
        );
    }

    #[test]
    fn only_one_side_can_answer_a_request() {
        let flight = InFlight::default();
        let _ = flight.register("abc", "main");

        // The cancel gets there first and takes the right to reply.
        let cancelling = flight.claim("abc").expect("still in flight");
        assert_eq!(cancelling.window, "main");

        // The worker finishing afterwards finds nothing, so it stays quiet
        // rather than sending a second response for the same id.
        assert!(flight.claim("abc").is_none());
    }

    #[test]
    fn cancelling_an_unknown_id_finds_nothing_to_cancel() {
        let flight = InFlight::default();
        assert!(flight.claim("never-sent").is_none());
        assert!(!flight.cancel_stream(42));
    }

    #[test]
    fn a_cancelled_flag_is_visible_to_the_worker_that_holds_it() {
        let flight = InFlight::default();
        let flag = flight.register("abc", "main");
        assert!(!flag.load(Ordering::SeqCst));

        let entry = flight.claim("abc").expect("still in flight");
        entry.cancelled.store(true, Ordering::SeqCst);

        // The worker reads the same flag it was handed at registration.
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn requests_do_not_share_a_cancellation_flag() {
        let flight = InFlight::default();
        let first = flight.register("one", "main");
        let second = flight.register("two", "main");

        flight
            .claim("one")
            .expect("in flight")
            .cancelled
            .store(true, Ordering::SeqCst);

        assert!(first.load(Ordering::SeqCst));
        assert!(!second.load(Ordering::SeqCst));
    }

    #[test]
    fn a_stream_keeps_the_flag_of_the_request_that_opened_it() {
        // So one `cancel` covers both phases: waiting for the head, and
        // reading the body afterwards.
        let flight = InFlight::default();
        let flag = flight.register("abc", "main");
        let stream = flight.open_stream(Arc::clone(&flag));

        assert!(flight.cancel_stream(stream));
        assert!(flag.load(Ordering::SeqCst));

        // And it is gone, so a second cancel says so rather than pretending.
        assert!(!flight.cancel_stream(stream));
    }

    #[test]
    fn stream_ids_are_not_reused_while_others_are_open() {
        let flight = InFlight::default();
        let first = flight.open_stream(Arc::new(AtomicBool::new(false)));
        let second = flight.open_stream(Arc::new(AtomicBool::new(false)));
        assert_ne!(first, second);

        flight.close_stream(first);
        let third = flight.open_stream(Arc::new(AtomicBool::new(false)));
        assert_ne!(third, second);
        assert_ne!(third, first);
    }

    #[test]
    fn a_character_split_across_two_chunks_survives() {
        // The failure this prevents: a stream of JSON where one event has an
        // accent in it becomes unparseable because the chunk boundary landed
        // in the middle of the character.
        let text = "caf\u{e9} \u{1f600}";
        let bytes = text.as_bytes();

        for split in 1..bytes.len() {
            let mut carry = Vec::new();
            let mut out = String::new();
            out.push_str(&decode_text(&mut carry, &bytes[..split]));
            out.push_str(&decode_text(&mut carry, &bytes[split..]));
            assert_eq!(out, text, "split at {split}");
            assert!(carry.is_empty(), "nothing left over at {split}");
        }
    }

    #[test]
    fn bytes_that_are_not_utf8_at_all_do_not_stall_the_stream() {
        // A truncated tail is held back; genuinely invalid bytes are not, or
        // the stream would wait forever for a character that is not coming.
        let mut carry = Vec::new();
        let text = decode_text(&mut carry, &[b'a', 0xff, b'b']);
        assert_eq!(text, "a\u{FFFD}");
        assert_eq!(carry, vec![b'b']);
    }

    #[test]
    fn sub_millisecond_answers_do_not_round_to_zero() {
        // A device on the LAN can answer in well under a millisecond, and a
        // timing breakdown of all zeroes would be worse than none.
        assert!(millis(Duration::from_micros(400)) > 0.0);
        assert_eq!(millis(Duration::from_millis(250)), 250.0);
    }
}
