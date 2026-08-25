//! `mdns.*` - finding devices on the local network.
//!
//! Every device a desktop application is likely to want - a smart-home hub, a
//! light, a desk display, a printer, a single-board computer - announces
//! itself over multicast DNS, and no browser can hear it. Asking the user to
//! type in an IP address is the alternative, which is why this is a platform
//! capability rather than an application's problem.
//!
//! Vantail knows what a service type is and nothing about what answers to it.
//! Discovering `_hub._tcp.local` is a generic operation; knowing what protocol
//! the result speaks is the application's business.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::ipc::{Event, Outgoing, Request, Response};
use crate::state::{MainCtx, Runtime};

/// Long enough for a quiet device to answer, short enough that an application
/// calling `discover()` on a button press does not feel broken.
const DEFAULT_TIMEOUT_MS: u64 = 3_000;
const MAX_TIMEOUT_MS: u64 = 60_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverParams {
    /// A service type such as `_hub._tcp.local`. The trailing dot is optional.
    service: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowseParams {
    service: String,
}

#[derive(Deserialize)]
struct StopParams {
    service: String,
}

/// The daemon, and the service types currently being watched.
///
/// Started lazily: it opens multicast sockets and runs a thread, and an
/// application that never discovers anything should not pay for that - nor
/// trip the local-network permission prompt on macOS.
#[derive(Default)]
pub struct Discovery {
    daemon: Mutex<Option<ServiceDaemon>>,
    browsing: Mutex<Vec<String>>,
}

impl Discovery {
    fn daemon(&self) -> Result<ServiceDaemon, ApiError> {
        let mut slot = self.daemon.lock().expect("mdns daemon poisoned");
        if slot.is_none() {
            *slot = Some(ServiceDaemon::new().map_err(|e| {
                ApiError::unsupported(format!("Could not start mDNS discovery: {e}"))
            })?);
        }
        // The daemon is a handle around a shared thread, so cloning it is how
        // the crate expects it to be used.
        Ok(slot.as_ref().expect("just created").clone())
    }

    /// Stop everything on the way out, so the sockets close with the process.
    pub fn shutdown(&self) {
        if let Some(daemon) = self.daemon.lock().expect("mdns daemon poisoned").take() {
            let browsing =
                std::mem::take(&mut *self.browsing.lock().expect("mdns browse poisoned"));
            for service in browsing {
                let _ = daemon.stop_browse(&service);
            }
            let _ = daemon.shutdown();
        }
    }
}

/// `None` means the response arrives later, from the discovery thread.
pub fn dispatch(ctx: &mut MainCtx<'_>, id: &str, method: &str, params: Value) -> Option<ApiResult> {
    let rt = ctx.rt.clone();
    let source = ctx.source.to_string();

    match method {
        "mdns.discover" => {
            let request_id = id.to_string();
            match start_discovery(&rt, &source, &request_id, params) {
                Ok(()) => None,
                Err(error) => Some(Err(error)),
            }
        }
        "mdns.browse" => Some(browse(&rt, &source, params)),
        "mdns.stop" => Some(stop(&rt, method, params)),
        "mdns.browsing" => Some(Ok(json!(rt
            .discovery
            .browsing
            .lock()
            .expect("mdns browse poisoned")
            .clone()))),
        _ => Some(Err(ApiError::unknown_method(method))),
    }
}

/// Normalise a service type to the form the resolver expects.
///
/// Applications write `_hub._tcp.local`; the wire format wants the trailing
/// dot. Accepting both is a kindness that costs one line.
fn normalise(service: &str) -> Result<String, ApiError> {
    let trimmed = service.trim();
    if trimmed.is_empty() {
        return Err(ApiError::invalid_params("A service type cannot be empty"));
    }
    if !trimmed.starts_with('_') || !trimmed.contains("._tcp") && !trimmed.contains("._udp") {
        return Err(ApiError::invalid_params(format!(
            "`{service}` is not a service type. They look like `_hub._tcp.local`."
        )));
    }
    Ok(if trimmed.ends_with('.') {
        trimmed.to_string()
    } else {
        format!("{trimmed}.")
    })
}

fn permitted(rt: &Runtime, service: &str, method: &str) -> Result<(), ApiError> {
    rt.permissions
        .check_service(service)
        .map_err(|error| error.with_data(json!({ "method": method, "service": service })))
}

fn start_discovery(
    rt: &Arc<Runtime>,
    source: &str,
    request_id: &str,
    params: Value,
) -> Result<(), ApiError> {
    let params: DiscoverParams = Request::params("mdns.discover", params)?;
    let service = normalise(&params.service)?;
    permitted(rt, &service, "mdns.discover")?;

    let timeout = Duration::from_millis(
        params
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS),
    );

    let daemon = rt.discovery.daemon()?;
    let receiver = daemon
        .browse(&service)
        .map_err(|e| ApiError::internal(format!("Could not browse for `{service}`: {e}")))?;

    let rt = Arc::clone(rt);
    let source = source.to_string();
    let request_id = request_id.to_string();

    let spawned = std::thread::Builder::new()
        .name("vantail-mdns".into())
        .spawn(move || {
            // Keyed by full name so a device answering on several interfaces
            // is one result rather than three.
            let mut found: BTreeMap<String, Value> = BTreeMap::new();
            let deadline = Instant::now() + timeout;

            while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
                match receiver.recv_timeout(remaining) {
                    Ok(ServiceEvent::ServiceResolved(resolved)) => {
                        found.insert(resolved.fullname.clone(), describe(&resolved));
                    }
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }

            let _ = daemon.stop_browse(&service);
            rt.send(
                Some(source),
                Outgoing::Response(Response::from_result(
                    request_id,
                    Ok(Value::Array(found.into_values().collect())),
                )),
            );
        });

    spawned
        .map(|_| ())
        .map_err(|e| ApiError::internal(format!("Could not start discovery: {e}")))
}

fn browse(rt: &Arc<Runtime>, source: &str, params: Value) -> ApiResult {
    let params: BrowseParams = Request::params("mdns.browse", params)?;
    let service = normalise(&params.service)?;
    permitted(rt, &service, "mdns.browse")?;

    {
        let mut browsing = rt.discovery.browsing.lock().expect("mdns browse poisoned");
        if browsing.contains(&service) {
            return Ok(json!({ "service": service, "started": false }));
        }
        browsing.push(service.clone());
    }

    let daemon = rt.discovery.daemon()?;
    let receiver = daemon
        .browse(&service)
        .map_err(|e| ApiError::internal(format!("Could not browse for `{service}`: {e}")))?;

    let rt_for_thread = Arc::clone(rt);
    let source = source.to_string();
    let watched = service.clone();

    let spawned = std::thread::Builder::new()
        .name("vantail-mdns-browse".into())
        .spawn(move || {
            // Ends when `mdns.stop` drops the sender, or at shutdown.
            for event in receiver {
                let message = match event {
                    ServiceEvent::ServiceResolved(resolved) => {
                        Some(("mdns.found", describe(&resolved)))
                    }
                    ServiceEvent::ServiceRemoved(_, fullname) => Some((
                        "mdns.lost",
                        json!({ "service": watched, "name": instance_name(&fullname), "fullname": fullname }),
                    )),
                    _ => None,
                };

                if let Some((name, payload)) = message {
                    rt_for_thread.send(
                        Some(source.clone()),
                        Outgoing::Event(Event::new(name, payload)),
                    );
                }
            }

            rt_for_thread
                .discovery
                .browsing
                .lock()
                .expect("mdns browse poisoned")
                .retain(|current| current != &watched);
        });

    match spawned {
        Ok(_) => Ok(json!({ "service": service, "started": true })),
        Err(error) => Err(ApiError::internal(format!(
            "Could not start discovery: {error}"
        ))),
    }
}

fn stop(rt: &Runtime, method: &str, params: Value) -> ApiResult {
    let StopParams { service } = Request::params(method, params)?;
    let service = normalise(&service)?;

    let was_browsing = {
        let mut browsing = rt.discovery.browsing.lock().expect("mdns browse poisoned");
        let before = browsing.len();
        browsing.retain(|current| current != &service);
        browsing.len() != before
    };

    if was_browsing {
        let daemon = rt.discovery.daemon()?;
        let _ = daemon.stop_browse(&service);
    }
    Ok(json!(was_browsing))
}

fn describe(resolved: &ResolvedService) -> Value {
    let mut addresses: Vec<String> = resolved
        .addresses
        .iter()
        .map(|address| address.to_string())
        .collect();
    // Stable order, so a UI listing devices does not reshuffle them.
    addresses.sort();

    let txt: BTreeMap<String, String> = resolved
        .txt_properties
        .iter()
        .map(|property| (property.key().to_string(), property.val_str().to_string()))
        .collect();

    json!({
        "service": resolved.ty_domain,
        "name": instance_name(&resolved.fullname),
        "fullname": resolved.fullname,
        "host": resolved.host,
        "port": resolved.port,
        "addresses": addresses,
        "txt": txt,
    })
}

/// `Living Room Hub._hub._tcp.local.` is really just `Living Room Hub`.
fn instance_name(fullname: &str) -> String {
    fullname
        .split_once("._")
        .map(|(name, _)| name.to_string())
        .unwrap_or_else(|| fullname.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_service_type_gets_its_trailing_dot() {
        assert_eq!(normalise("_hub._tcp.local").unwrap(), "_hub._tcp.local.");
        assert_eq!(normalise("_hub._tcp.local.").unwrap(), "_hub._tcp.local.");
        assert_eq!(
            normalise("  _elg._tcp.local  ").unwrap(),
            "_elg._tcp.local."
        );
    }

    #[test]
    fn a_hostname_is_not_a_service_type() {
        // The mistake worth catching: passing the device instead of the type.
        assert!(normalise("hub.local").is_err());
        assert!(normalise("").is_err());
        assert!(normalise("_hub.local").is_err());
    }

    #[test]
    fn an_instance_name_drops_the_service_type() {
        assert_eq!(
            instance_name("Living Room Hub._hub._tcp.local."),
            "Living Room Hub"
        );
        assert_eq!(
            instance_name("Key Light 4B2C._elg._tcp.local."),
            "Key Light 4B2C"
        );
        assert_eq!(instance_name("odd"), "odd");
    }
}
