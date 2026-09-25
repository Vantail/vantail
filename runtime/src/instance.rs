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
fn socket_path(identifier: &str) -> std::path::PathBuf {
    let key = format!("vantail-{identifier}");
    std::env::temp_dir().join(format!("{key}.sock"))
}

fn socket_name(identifier: &str) -> std::io::Result<Name<'static>> {
    let key = format!("vantail-{identifier}");

    if GenericNamespaced::is_supported() {
        return key.to_ns_name::<GenericNamespaced>();
    }

    socket_path(identifier).to_fs_name::<GenericFilePath>()
}

/// Remove a socket file left behind by a process that died without cleaning
/// up (crash, SIGKILL, power loss).
///
/// Only meaningful where the socket is a file - the namespaces Linux and
/// Windows use vanish with the process, so there is nothing to clean. Missing
/// files are fine: that just means there was nothing stale.
fn remove_stale_socket(identifier: &str) {
    if GenericNamespaced::is_supported() {
        return;
    }

    let path = socket_path(identifier);
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            eprintln!("vantail: could not clear stale instance socket: {error}");
        }
    }
}

/// Hand our arguments to the instance already listening, if there is one.
///
/// Returns `Ok(true)` when another instance answered, `Ok(false)` when nobody
/// is listening. A connection proves a primary is alive, so a handover that
/// connected still counts as handed over even if the message itself failed to
/// send - opening a second copy would be worse than losing the arguments.
fn try_handover(name: &Name<'static>, args: &[String]) -> std::io::Result<bool> {
    let Ok(mut stream) = Stream::connect(name.clone()) else {
        return Ok(false);
    };

    let launch = Launch {
        args: args.to_vec(),
        cwd: std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
    };
    let mut line = serde_json::to_string(&launch).unwrap_or_else(|_| "{}".into());
    line.push('\n');
    if let Err(error) = stream
        .write_all(line.as_bytes())
        .and_then(|()| stream.flush())
    {
        eprintln!("vantail: could not hand over to the running instance: {error}");
    }
    Ok(true)
}

/// Become the only instance, or hand our arguments to the one already running.
///
/// A failure to bind is not fatal: an application that cannot single-instance
/// itself should still start, because refusing to run is worse than running
/// twice.
///
/// A stale socket file - a crash or SIGKILL leaves the macOS socket file
/// behind, and its `reclaim_name` only unlinks on a clean shutdown, not on
/// the next bind - looks exactly like a live primary (`AddrInUse`), as does
/// losing a startup race with another process. So an `AddrInUse` is never
/// taken at face value: it is followed by another handover attempt (a winner
/// that bound between our first attempt and now answers this one), and only
/// when nobody answers is the file treated as stale, removed, and bound
/// again.
pub fn claim(identifier: &str, args: Vec<String>) -> std::io::Result<Claim> {
    let name = socket_name(identifier)?;

    // Somebody listening means somebody is running.
    if try_handover(&name, &args)? {
        return Ok(Claim::HandedOver);
    }

    match ListenerOptions::new().name(name.clone()).create_sync() {
        Ok(listener) => Ok(Claim::Primary(listener)),
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            // Give a concurrent starter a moment to start listening, then ask
            // again: whoever won the race answers here.
            std::thread::sleep(std::time::Duration::from_millis(50));
            if try_handover(&name, &args)? {
                return Ok(Claim::HandedOver);
            }

            // Nobody answered, so nothing live holds the name - the file is
            // left over from a process that died without cleaning up.
            remove_stale_socket(identifier);

            match ListenerOptions::new().name(name.clone()).create_sync() {
                Ok(listener) => Ok(Claim::Primary(listener)),
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                    // Lost the race twice: someone bound while the stale file
                    // was being cleared. They should answer now.
                    if try_handover(&name, &args)? {
                        return Ok(Claim::HandedOver);
                    }
                    Err(error)
                }
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_id(tag: &str) -> String {
        format!("test-{tag}-{}-{}", std::process::id(), rand_suffix())
    }

    fn rand_suffix() -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        std::thread::current().id().hash(&mut hasher);
        std::time::SystemTime::now().hash(&mut hasher);
        hasher.finish()
    }

    #[test]
    fn a_second_claim_hands_over_to_the_first() {
        let id = unique_id("handover");
        let primary = claim(&id, vec!["first".into()]).expect("first claim is primary");
        assert!(matches!(primary, Claim::Primary(_)));

        match claim(&id, vec!["second".into()]).expect("second claim should not error") {
            Claim::HandedOver => {}
            Claim::Primary(_) => panic!("second claim should hand over, not become primary"),
        }

        // Dropping the primary releases the name; a later claim is primary again.
        drop(primary);
    }

    #[test]
    #[cfg(unix)]
    fn a_stale_socket_file_does_not_block_the_next_launch() {
        // A crash or SIGKILL leaves the macOS socket file behind with nobody
        // listening. The next launch used to fail with
        // `Address already in use (os error 48)`; it must reclaim the name.
        if GenericNamespaced::is_supported() {
            return;
        }

        let id = unique_id("stale");
        let path = socket_path(&id);
        let _ = std::fs::remove_file(&path);

        // Plant a stale socket: bind a raw listener, then close it without
        // unlinking. `std` leaves the file behind on drop, which is exactly
        // what a crashed or SIGKILLed process leaves behind: a socket file
        // with nobody listening.
        {
            let stale = std::os::unix::net::UnixListener::bind(&path).expect("plant stale socket");
            drop(stale);
        }
        assert!(path.exists(), "stale socket file should exist");

        let primary = claim(&id, vec!["after-crash".into()])
            .expect("claim after a stale socket file should succeed");
        assert!(
            matches!(primary, Claim::Primary(_)),
            "nobody is listening, so this launch is primary"
        );
        drop(primary);
    }
}
