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

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use ureq::http;

use crate::error::{ApiError, ApiResult};
use crate::ipc::{Outgoing, Request, Response};
use crate::permissions::network::Endpoint;
use crate::state::{MainCtx, Runtime};

const BASE64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// A response has to fit in a JSON string on its way to the webview, so there
/// is a ceiling. Generous for an API call, far too small for a video.
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

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
    /// `text` (default) or `base64`.
    #[serde(default)]
    response_type: Option<String>,
}

fn default_method() -> String {
    "GET".to_string()
}

pub fn dispatch(ctx: &mut MainCtx<'_>, id: &str, method: &str, params: Value) -> Option<ApiResult> {
    if method != "network.request" {
        return Some(Err(ApiError::unknown_method(method)));
    }

    let rt = ctx.rt.clone();
    let request_id = id.to_string();
    let source = ctx.source.to_string();
    let reply_to = source.clone();

    // Queued on the network pool rather than the filesystem one: a device
    // that has gone away takes the full timeout to say so, and should not
    // hold up a file read while it does.
    let queued = ctx.network.execute(move || {
        let result = perform(&rt, params);
        rt.send(
            Some(reply_to),
            Outgoing::Response(Response::from_result(request_id, result)),
        );
    });

    match queued {
        Ok(()) => None,
        Err(error) => Some(Err(error)),
    }
}

fn perform(rt: &Arc<Runtime>, params: Value) -> ApiResult {
    let params: RequestParams = Request::params("network.request", params)?;

    let binary = match params.response_type.as_deref() {
        None | Some("text") => false,
        Some("base64") => true,
        Some(other) => {
            return Err(ApiError::invalid_params(format!(
                "`responseType` must be \"text\" or \"base64\", not \"{other}\""
            )))
        }
    };

    let mut body = match (&params.body_base64, &params.body) {
        (Some(encoded), _) => BASE64.decode(encoded.as_bytes()).map_err(|e| {
            ApiError::invalid_params(format!("`bodyBase64` is not valid base64: {e}"))
        })?,
        (None, Some(text)) => text.as_bytes().to_vec(),
        (None, None) => Vec::new(),
    };

    let mut method = params.method.to_ascii_uppercase();
    let mut url = params.url.clone();
    let mut headers = params.headers.clone();
    let timeout = Duration::from_millis(params.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let allowed_hops = params.max_redirects.unwrap_or(DEFAULT_MAX_REDIRECTS);

    let mut previous: Option<Endpoint> = None;

    for _ in 0..=allowed_hops {
        // Every hop, not just the first. This is the whole reason redirects
        // are followed here rather than by the HTTP client.
        let endpoint = rt.permissions.network.check(&url)?;

        if let Some(previous) = &previous {
            if previous.host != endpoint.host {
                // Browsers drop credentials when a redirect crosses origins,
                // and so does this: a redirect must not be able to hand an
                // API token to somebody else.
                headers.retain(|name, _| {
                    let name = name.to_ascii_lowercase();
                    name != "authorization" && name != "cookie" && name != "proxy-authorization"
                });
            }
        }

        let insecure = rt.permissions.network.allows_invalid_certificate(&endpoint);
        let response = send(&method, &url, &headers, &body, timeout, insecure)?;

        let status = response.status;
        match redirect_target(&response, &url) {
            Some(location) if status.is_redirection() => {
                // 303, and 301/302 in practice, turn everything into a GET.
                if status.as_u16() != 307 && status.as_u16() != 308 {
                    method = "GET".to_string();
                    body.clear();
                    headers.retain(|name, _| !name.eq_ignore_ascii_case("content-type"));
                }
                previous = Some(endpoint);
                url = location;
            }
            _ => return Ok(render(&url, response, binary)),
        }
    }

    Err(ApiError::new(
        crate::error::code::IO_ERROR,
        format!("`{}` redirected more than {allowed_hops} times", params.url),
    ))
}

struct Received {
    status: http::StatusCode,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn send(
    method: &str,
    url: &str,
    headers: &BTreeMap<String, String>,
    body: &[u8],
    timeout: Duration,
    insecure: bool,
) -> Result<Received, ApiError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        // Redirects are followed by hand, so each hop can be checked.
        .max_redirects(0)
        .max_redirects_will_error(false)
        // A 404 is an answer, not a transport failure; the caller wants the
        // status rather than an exception.
        .http_status_as_error(false)
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .disable_verification(insecure)
                .build(),
        )
        .build()
        .into();

    let mut builder = http::Request::builder().method(method).uri(url);
    for (name, value) in headers {
        builder = builder.header(name, value);
    }

    let request = builder.body(body.to_vec()).map_err(|e| {
        // A bad method, a bad URL, or a header value with a newline in it.
        ApiError::invalid_params(format!("Could not build the request: {e}"))
    })?;

    let mut response = agent
        .run(request)
        .map_err(|e| ApiError::new(crate::error::code::IO_ERROR, describe(url, &e)))?;

    let status = response.status();
    let mut collected = BTreeMap::new();
    for (name, value) in response.headers() {
        let text = value.to_str().unwrap_or_default().to_string();
        collected
            .entry(name.as_str().to_ascii_lowercase())
            .and_modify(|existing: &mut String| {
                // Repeated headers - Set-Cookie, mostly - are joined the way
                // the fetch spec joins them.
                existing.push_str(", ");
                existing.push_str(&text);
            })
            .or_insert(text);
    }

    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_RESPONSE_BYTES as u64)
        .read_to_vec()
        .map_err(|e| {
            ApiError::new(
                crate::error::code::IO_ERROR,
                format!("Could not read the response from `{url}`: {e}"),
            )
        })?;

    Ok(Received {
        status,
        headers: collected,
        body,
    })
}

fn redirect_target(response: &Received, base: &str) -> Option<String> {
    let location = response.headers.get("location")?;
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

    let (scheme, rest) = base.split_once("://").unwrap_or(("http", base));
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let origin = format!("{scheme}://{authority}");

    if location.starts_with('/') {
        return format!("{origin}{location}");
    }

    let path = &rest[authority.len()..];
    let directory = match path.rfind('/') {
        Some(at) => &path[..=at],
        None => "/",
    };
    format!("{origin}{directory}{location}")
}

fn render(url: &str, response: Received, binary: bool) -> Value {
    let status = response.status.as_u16();
    let (body, encoding) = if binary {
        (BASE64.encode(&response.body), "base64")
    } else {
        (String::from_utf8_lossy(&response.body).into_owned(), "text")
    };

    json!({
        "url": url,
        "status": status,
        "statusText": response.status.canonical_reason().unwrap_or(""),
        "ok": (200..300).contains(&status),
        "headers": response.headers,
        "body": body,
        "encoding": encoding,
    })
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
}
