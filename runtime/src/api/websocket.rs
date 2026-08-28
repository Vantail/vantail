//! `network.socket` - WebSocket, for the APIs that only speak it.
//!
//! The webview has a perfectly good `WebSocket`, and an application should
//! use it when it can. What it cannot do is set a header on the opening
//! handshake, which is how most APIs authenticate one - the browser API takes
//! a URL and a subprotocol list and nothing else, so a bearer token has to go
//! in the query string, where it ends up in logs. It is also subject to the
//! same origin rules as everything else in the page.
//!
//! This is that handshake made from the runtime instead: arbitrary headers,
//! no CORS, and the same `permissions.network` check every other request
//! goes through.
//!
//! A socket is one thread, which owns it. The protocol is full duplex but a
//! `tungstenite::WebSocket` is not, so reads and writes take turns: the read
//! blocks for at most `POLL`, then the loop drains whatever the application
//! asked to send. That bounds send latency at `POLL` rather than at "whenever
//! the server next says something", which is what a plain blocking read would
//! mean for a socket that is quiet.

use std::collections::{BTreeMap, HashMap};
use std::io::ErrorKind;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::CloseFrame;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Bytes, Message, WebSocket};

use crate::error::{ApiError, ApiResult};
use crate::ipc::{Event, Outgoing, Request, Response};
use crate::state::{MainCtx, Runtime};

const BASE64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// How long a read waits before the loop looks at the outgoing queue.
///
/// One thread owns the socket, so a send waits for the read to come up for
/// air. Ten milliseconds is well below anything a person notices and costs a
/// hundred idle syscalls a second, which is nothing.
const POLL: Duration = Duration::from_millis(10);

const DEFAULT_TIMEOUT_MS: u64 = 30_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenParams {
    /// `ws://` or `wss://`.
    url: String,
    /// Sent on the opening handshake. The reason this exists at all.
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    protocols: Vec<String>,
    /// Applies to connecting and to the handshake, not to the socket's life.
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendParams {
    id: u32,
    /// Text, or base64 when `binary`.
    data: String,
    #[serde(default)]
    binary: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloseParams {
    id: u32,
    #[serde(default)]
    code: Option<u16>,
    #[serde(default)]
    reason: Option<String>,
}

/// What the application asked the socket's own thread to do.
enum Command {
    Send(Message),
    Close(Option<CloseFrame>),
}

/// Open sockets, by the id the application knows them by.
#[derive(Default)]
pub struct Sockets {
    next: AtomicU32,
    open: Mutex<HashMap<u32, Sender<Command>>>,
}

impl Sockets {
    fn insert(&self, commands: Sender<Command>) -> u32 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.open
            .lock()
            .expect("sockets poisoned")
            .insert(id, commands);
        id
    }

    fn remove(&self, id: u32) {
        self.open.lock().expect("sockets poisoned").remove(&id);
    }

    fn tell(&self, id: u32, command: Command) -> Result<(), ApiError> {
        let open = self.open.lock().expect("sockets poisoned");
        let Some(commands) = open.get(&id) else {
            return Err(ApiError::new(
                crate::error::code::NOT_FOUND,
                format!("There is no open socket with id {id}"),
            ));
        };
        // The thread is gone but the entry has not been cleaned up yet, which
        // is the same thing to a caller as a socket that has closed.
        commands.send(command).map_err(|_| {
            ApiError::new(
                crate::error::code::NOT_FOUND,
                format!("Socket {id} has closed"),
            )
        })
    }

    /// Ask every socket to close, on the way out.
    pub fn shutdown(&self) {
        let open = std::mem::take(&mut *self.open.lock().expect("sockets poisoned"));
        for (_, commands) in open {
            let _ = commands.send(Command::Close(None));
        }
    }
}

pub fn dispatch(ctx: &mut MainCtx<'_>, id: &str, method: &str, params: Value) -> Option<ApiResult> {
    match method {
        "network.socket" => open(ctx, id, params),
        "network.socketSend" => Some(post(ctx, params)),
        "network.socketClose" => Some(shut(ctx, params)),
        _ => Some(Err(ApiError::unknown_method(method))),
    }
}

/// Open a socket. Returns `None`: the reply comes from the socket's thread.
fn open(ctx: &mut MainCtx<'_>, id: &str, params: Value) -> Option<ApiResult> {
    let rt = ctx.rt.clone();
    let request_id = id.to_string();
    let window = ctx.source.to_string();
    // Registered like any other request, so `signal` can abandon a handshake
    // that is taking too long the same way it abandons a slow GET.
    let cancelled = rt.requests.register(id, ctx.source);

    let spawned = std::thread::Builder::new()
        .name(format!("vantail-socket-{id}"))
        .spawn(move || run(rt, window, request_id, params, cancelled));

    match spawned {
        Ok(_) => None,
        Err(error) => {
            let _ = ctx.rt.requests.claim(id);
            Some(Err(ApiError::internal(format!(
                "Could not start a thread for the socket: {error}"
            ))))
        }
    }
}

fn post(ctx: &mut MainCtx<'_>, params: Value) -> ApiResult {
    let SendParams { id, data, binary } = Request::params("network.socketSend", params)?;
    let message = if binary {
        let bytes = BASE64
            .decode(data.as_bytes())
            .map_err(|e| ApiError::invalid_params(format!("`data` is not valid base64: {e}")))?;
        Message::Binary(Bytes::from(bytes))
    } else {
        Message::Text(data.into())
    };

    ctx.rt.sockets.tell(id, Command::Send(message))?;
    Ok(Value::Null)
}

fn shut(ctx: &mut MainCtx<'_>, params: Value) -> ApiResult {
    let CloseParams { id, code, reason } = Request::params("network.socketClose", params)?;
    let frame = code.map(|code| CloseFrame {
        code: CloseCode::from(code),
        reason: reason.unwrap_or_default().into(),
    });
    ctx.rt.sockets.tell(id, Command::Close(frame))?;
    Ok(Value::Null)
}

// ---------------------------------------------------------------------------
// The socket's own thread
// ---------------------------------------------------------------------------

fn run(
    rt: Arc<Runtime>,
    window: String,
    request_id: String,
    params: Value,
    cancelled: Arc<AtomicBool>,
) {
    let connected = connect(&rt, params);

    let (socket, url, protocol) = match connected {
        Ok(opened) => opened,
        Err(error) => {
            if let Some(entry) = rt.requests.claim(&request_id) {
                rt.send(
                    Some(entry.window),
                    Outgoing::Response(Response::from_result(request_id, Err(error))),
                );
            }
            return;
        }
    };

    let (commands, inbox) = channel();
    let id = rt.sockets.insert(commands);

    // A cancel that arrived during the handshake has already answered the
    // call, so there is nobody to hand the socket to.
    if rt.requests.claim(&request_id).is_none() {
        rt.sockets.remove(id);
        return;
    }

    rt.send(
        Some(window.clone()),
        Outgoing::Response(Response::from_result(
            request_id,
            Ok(json!({ "id": id, "url": url, "protocol": protocol })),
        )),
    );

    pump(&rt, &window, id, socket, inbox, &cancelled);
}

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

fn connect(rt: &Arc<Runtime>, params: Value) -> Result<(Socket, String, Option<String>), ApiError> {
    let params: OpenParams = Request::params("network.socket", params)?;

    // The same check, and the same prompt, an HTTP request goes through.
    let endpoint = super::network::authorise(rt, &params.url)?;
    let secure = match endpoint.scheme.as_str() {
        "wss" => true,
        "ws" => false,
        other => {
            return Err(ApiError::invalid_params(format!(
                "`{other}://` is not a WebSocket URL - use `ws://` or `wss://`"
            )))
        }
    };

    let timeout = Duration::from_millis(params.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let port = endpoint.port.unwrap_or(if secure { 443 } else { 80 });

    // Connected by hand rather than by `tungstenite::connect`, which has no
    // timeout: a device that is off would otherwise hang until the OS gave up.
    let address = (endpoint.host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| {
            ApiError::new(
                crate::error::code::IO_ERROR,
                format!("Could not resolve `{}`: {e}", endpoint.host),
            )
        })?
        .next()
        .ok_or_else(|| {
            ApiError::new(
                crate::error::code::IO_ERROR,
                format!("`{}` resolved to no addresses", endpoint.host),
            )
        })?;

    let stream = TcpStream::connect_timeout(&address, timeout).map_err(|e| {
        ApiError::new(
            crate::error::code::IO_ERROR,
            format!("Could not reach `{}`: {e}", params.url),
        )
    })?;
    // A socket is usually many small messages, and Nagle would sit on them.
    let _ = stream.set_nodelay(true);
    // Covers the handshake. Cleared once the socket is up, where `POLL` takes
    // over.
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    // Built through tungstenite's own builder rather than by hand: the
    // handshake needs `Sec-WebSocket-Key`, `Sec-WebSocket-Version`, `Upgrade`
    // and `Connection` to be right, and a request missing any of them is
    // rejected by the client before it reaches the wire.
    let uri: tungstenite::http::Uri = params.url.parse().map_err(|e| {
        ApiError::invalid_params(format!("`{}` is not a usable URL: {e}", params.url))
    })?;
    let mut request = tungstenite::ClientRequestBuilder::new(uri);
    for (name, value) in &params.headers {
        request = request.with_header(name, value);
    }
    for protocol in &params.protocols {
        request = request.with_sub_protocol(protocol);
    }

    let (socket, response) = tungstenite::client_tls(request, stream).map_err(|e| {
        ApiError::new(
            crate::error::code::IO_ERROR,
            format!("The WebSocket handshake with `{}` failed: {e}", params.url),
        )
    })?;

    // Which subprotocol the server actually picked, which is not necessarily
    // the first one offered.
    let protocol = response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    Ok((socket, params.url, protocol))
}

fn pump(
    rt: &Arc<Runtime>,
    window: &str,
    id: u32,
    mut socket: Socket,
    inbox: Receiver<Command>,
    cancelled: &AtomicBool,
) {
    if let Some(stream) = tcp(socket.get_ref()) {
        let _ = stream.set_read_timeout(Some(POLL));
    }

    let mut failure: Option<String> = None;
    let mut code: Option<u16> = None;
    let mut reason = String::new();
    let mut closing = false;

    'pump: loop {
        // A cancelled request means the application let go of this socket, so
        // close it politely rather than dropping the connection on the floor.
        if cancelled.load(Ordering::SeqCst) && !closing {
            closing = true;
            let _ = socket.close(None);
        }

        loop {
            match inbox.try_recv() {
                Ok(Command::Send(message)) => {
                    if let Err(error) = socket.send(message) {
                        failure = Some(error.to_string());
                        break 'pump;
                    }
                }
                Ok(Command::Close(frame)) => {
                    closing = true;
                    // Sends the close frame; the server answers with its own,
                    // and the read below is what sees it.
                    let _ = socket.close(frame);
                }
                Err(TryRecvError::Empty) => break,
                // Every sender is gone, which only happens at shutdown.
                Err(TryRecvError::Disconnected) => {
                    if !closing {
                        closing = true;
                        let _ = socket.close(None);
                    }
                    break;
                }
            }
        }

        match socket.read() {
            Ok(Message::Text(text)) => emit(rt, window, id, text.as_str(), false),
            Ok(Message::Binary(bytes)) => emit(rt, window, id, &BASE64.encode(&bytes), true),
            Ok(Message::Close(frame)) => {
                if let Some(frame) = frame {
                    code = Some(frame.code.into());
                    reason = frame.reason.to_string();
                }
                // The read after a close frame is what finishes the handshake
                // and gives `ConnectionClosed`.
            }
            // Ping is answered by tungstenite itself, and flushed by the next
            // send or close. Pong and raw frames are not the application's
            // business.
            Ok(_) => {}
            Err(tungstenite::Error::Io(error)) if waiting(&error) => {}
            Err(tungstenite::Error::ConnectionClosed) | Err(tungstenite::Error::AlreadyClosed) => {
                break
            }
            Err(error) => {
                failure = Some(error.to_string());
                break;
            }
        }
    }

    rt.sockets.remove(id);
    rt.send(
        Some(window.to_string()),
        Outgoing::Event(Event::new(
            "network.socketClosed",
            json!({
                "id": id,
                "code": code,
                "reason": reason,
                "error": failure,
                "cancelled": cancelled.load(Ordering::SeqCst),
            }),
        )),
    );
}

fn emit(rt: &Arc<Runtime>, window: &str, id: u32, data: &str, binary: bool) {
    rt.send(
        Some(window.to_string()),
        Outgoing::Event(Event::new(
            "network.message",
            json!({ "id": id, "data": data, "binary": binary }),
        )),
    );
}

/// The read timed out with nothing to show, rather than failing.
///
/// Which of the two a read timeout reports is a platform decision: Unix says
/// `WouldBlock`, Windows says `TimedOut`. Both mean "ask again".
fn waiting(error: &std::io::Error) -> bool {
    matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
}

/// The TCP stream underneath, whether or not there is TLS on top of it.
#[allow(unreachable_patterns)]
fn tcp(stream: &MaybeTlsStream<TcpStream>) -> Option<&TcpStream> {
    match stream {
        MaybeTlsStream::Plain(stream) => Some(stream),
        MaybeTlsStream::Rustls(stream) => Some(&stream.sock),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_that_merely_timed_out_is_not_a_failure() {
        // Unix and Windows disagree about which of these a read timeout is,
        // and treating either as an error would close a healthy socket every
        // ten milliseconds.
        assert!(waiting(&std::io::Error::from(ErrorKind::WouldBlock)));
        assert!(waiting(&std::io::Error::from(ErrorKind::TimedOut)));
        assert!(!waiting(&std::io::Error::from(ErrorKind::ConnectionReset)));
    }

    #[test]
    fn socket_ids_start_at_one_and_do_not_repeat() {
        let sockets = Sockets::default();
        let (first_tx, _first) = channel();
        let (second_tx, _second) = channel();

        let first = sockets.insert(first_tx);
        let second = sockets.insert(second_tx);

        assert_eq!(first, 1);
        assert_ne!(first, second);
    }

    #[test]
    fn sending_to_a_socket_that_is_not_open_says_so() {
        let sockets = Sockets::default();
        let error = sockets
            .tell(7, Command::Close(None))
            .expect_err("no such socket");
        assert_eq!(error.code, crate::error::code::NOT_FOUND);
    }

    #[test]
    fn a_socket_whose_thread_has_gone_reads_as_closed() {
        let sockets = Sockets::default();
        let (tx, receiver) = channel();
        let id = sockets.insert(tx);

        // The thread ended without cleaning up, which is the race a caller
        // hits when it sends into a socket that has just closed.
        drop(receiver);

        let error = sockets
            .tell(id, Command::Close(None))
            .expect_err("the thread is gone");
        assert_eq!(error.code, crate::error::code::NOT_FOUND);
        assert!(error.message.contains("closed"));
    }

    #[test]
    fn shutdown_asks_every_socket_to_close() {
        let sockets = Sockets::default();
        let (tx, inbox) = channel();
        sockets.insert(tx);

        sockets.shutdown();

        assert!(matches!(inbox.try_recv(), Ok(Command::Close(None))));
        // And the registry is empty, so nothing is asked twice.
        assert!(sockets.open.lock().unwrap().is_empty());
    }
}
