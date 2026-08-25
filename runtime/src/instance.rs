//! One instance of an application, not several.
//!
//! Two reasons. The obvious one is that double-clicking an application twice
//! should not open two copies. The load-bearing one is deep links: on Windows
//! and Linux a `myapp://` URL arrives by *starting the application again* with
//! the URL as an argument, so unless the second process can hand it to the
//! first and get out of the way, the link opens a second copy of the app
//! instead of doing anything useful.
//!
//! The handover is a local socket - a Unix domain socket or a Windows named
//! pipe, not a TCP port. Nothing here is reachable from off the machine.

use std::io::{BufRead, BufReader, Write};

use interprocess::local_socket::traits::{ListenerExt as _, Stream as _};
use interprocess::local_socket::{
    GenericFilePath, GenericNamespaced, ListenerOptions, Name, NameType, Stream, ToFsName, ToNsName,
};
use serde::{Deserialize, Serialize};
use tao::event_loop::EventLoopProxy;

use crate::ipc::UserEvent;

/// What a second instance tells the first.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Launch {
    pub args: Vec<String>,
    pub cwd: String,
}

/// The outcome of trying to be the only instance.
pub enum Claim {
    /// Nothing else was running. The listener is held for the process's life.
    Primary(interprocess::local_socket::Listener),
    /// Another instance answered and has been told what we were asked to do.
    HandedOver,
}

/// Where the socket lives.
///
/// Linux and Windows have a namespace for these; macOS does not, so it gets a
/// path in the temp directory instead.
fn socket_name(identifier: &str) -> std::io::Result<Name<'static>> {
    let key = format!("vantail-{identifier}");

    if GenericNamespaced::is_supported() {
        return key.to_ns_name::<GenericNamespaced>();
    }

    std::env::temp_dir()
        .join(format!("{key}.sock"))
        .to_fs_name::<GenericFilePath>()
}

/// Become the only instance, or hand our arguments to the one already running.
///
/// A failure to bind is not fatal: an application that cannot single-instance
/// itself should still start, because refusing to run is worse than running
/// twice.
pub fn claim(identifier: &str, args: Vec<String>) -> std::io::Result<Claim> {
    let name = socket_name(identifier)?;

    // Somebody listening means somebody is running.
    if let Ok(mut stream) = Stream::connect(name.clone()) {
        let launch = Launch {
            args,
            cwd: std::env::current_dir()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default(),
        };
        let mut line = serde_json::to_string(&launch).unwrap_or_else(|_| "{}".into());
        line.push('\n');
        stream.write_all(line.as_bytes())?;
        stream.flush()?;
        return Ok(Claim::HandedOver);
    }

    // `reclaim_name` is on by default, which clears a socket file left behind
    // by a process that died without cleaning up.
    let listener = ListenerOptions::new().name(name).create_sync()?;
    Ok(Claim::Primary(listener))
}

/// Forward everything later instances say into the event loop.
pub fn listen(listener: interprocess::local_socket::Listener, proxy: EventLoopProxy<UserEvent>) {
    let spawned = std::thread::Builder::new()
        .name("vantail-instance".into())
        .spawn(move || {
            for connection in listener.incoming() {
                let Ok(connection) = connection else { continue };

                let mut line = String::new();
                if BufReader::new(connection).read_line(&mut line).is_err() {
                    continue;
                }
                let Ok(launch) = serde_json::from_str::<Launch>(&line) else {
                    // Something else is talking on our socket. Not ours to
                    // interpret.
                    continue;
                };

                if proxy.send_event(UserEvent::SecondInstance(launch)).is_err() {
                    // The event loop has gone; so should this thread.
                    break;
                }
            }
        });

    if spawned.is_err() {
        eprintln!("vantail: could not watch for other instances");
    }
}
