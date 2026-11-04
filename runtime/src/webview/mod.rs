//! Everything the webview needs: the JS bridge that gets injected before any
//! application code runs, and the `vantail://` protocol that serves the built
//! assets straight off disk.
//!
//! There is no localhost server, no port, and no token. The webview talks to
//! the runtime through the platform's own IPC channel, and loads its assets
//! through a scheme the runtime handles in-process.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use serde_json::json;
use wry::http::{header, HeaderValue, Request, Response, StatusCode};

use crate::state::Runtime;

pub const SCHEME: &str = "vantail";

/// The URL to load for a packaged app.
///
/// Windows maps custom schemes onto `http://<scheme>.<host>`; everywhere else
/// the scheme is used directly.
pub fn app_url(path: &str) -> String {
    let path = path.trim_start_matches('/');
    if cfg!(target_os = "windows") {
        format!("http://{SCHEME}.localhost/{path}")
    } else {
        format!("{SCHEME}://localhost/{path}")
    }
}

/// The pages that may talk to the runtime: the application's own, and in
/// development the dev server's.
///
/// A window can end up showing a page the application did not write - a link
/// followed, a redirect, a mistyped URL. The bridge is injected into whatever
/// loads and wry passes on IPC from whatever loads, so without this the
/// application's permissions would quietly extend to that page. Calls from
/// anywhere else are refused, and nothing the runtime pushes reaches it.
///
/// Trust is by origin rather than by URL, so routing and query strings inside
/// the application are unaffected.
#[derive(Clone, Debug)]
pub struct Origins {
    trusted: Vec<Origin>,
}

impl Origins {
    pub fn new(rt: &Runtime) -> Self {
        let dev = match &rt.config.dev {
            Some(dev) => Some(dev.url.as_str()),
            None => None,
        };
        Self::with_dev(dev)
    }

    /// The application's own origin and, in development, the dev server's.
    fn with_dev(dev: Option<&str>) -> Self {
        let mut urls = vec![app_url("")];
        if let Some(dev) = dev {
            urls.push(dev.to_string());
        }

        let mut trusted = Vec::new();
        for url in &urls {
            if let Some(origin) = Origin::parse(url) {
                trusted.push(origin);
            }
        }
        Self { trusted }
    }

    /// Whether the page at `url` is one of the application's own.
    pub fn allows(&self, url: &str) -> bool {
        match Origin::parse(url) {
            Some(origin) => self.trusted.contains(&origin),
            None => false,
        }
    }

    /// The trusted origins as a page sees itself: `location.protocol + '//' +
    /// location.host`. Not `location.origin`, which is `"null"` for a scheme
    /// the URL standard does not know, `vantail:` included.
    fn as_seen_by_page(&self) -> Vec<String> {
        let mut seen = Vec::with_capacity(self.trusted.len());
        for origin in &self.trusted {
            seen.push(origin.as_seen_by_page());
        }
        seen
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Origin {
    scheme: String,
    host: String,
    port: Option<u16>,
}

impl Origin {
    fn parse(url: &str) -> Option<Self> {
        let Ok(uri) = url.parse::<wry::http::Uri>() else {
            return None;
        };
        let scheme = uri.scheme_str()?.to_ascii_lowercase();
        let host = uri.host()?.to_ascii_lowercase();
        // `http://localhost` and `http://localhost:80` are the same page.
        let port = match uri.port_u16() {
            Some(port) => Some(port),
            None => default_port(&scheme),
        };
        Some(Self { scheme, host, port })
    }

    /// `scheme://host`, with the port only when it is not the scheme's own.
    fn as_seen_by_page(&self) -> String {
        match self.port {
            Some(port) if Some(port) != default_port(&self.scheme) => {
                format!("{}://{}:{port}", self.scheme, self.host)
            }
            _ => format!("{}://{}", self.scheme, self.host),
        }
    }
}

fn default_port(scheme: &str) -> Option<u16> {
    match scheme {
        "http" => Some(80),
        "https" => Some(443),
        _ => None,
    }
}

/// Whether a popup's URL is something to hand to the system instead: a web
/// page or a mail link, which a browser would have opened itself.
pub fn opens_externally(url: &str) -> bool {
    let Some((scheme, _)) = url.split_once(':') else {
        return false;
    };
    matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http" | "https" | "mailto"
    )
}

fn append_line(path: &std::ffi::OsStr, line: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{line}")
}

/// Hand a URL to the user's browser or mail client.
///
/// `VANTAIL_OPEN_STUB=<file>` appends the URL to that file instead. That is
/// what the integration tests set: a test run should not open a browser, and
/// what they check is which URLs would have left, not that a browser came up.
pub fn open_externally(url: &str) {
    if let Some(stub) = std::env::var_os("VANTAIL_OPEN_STUB") {
        if let Err(error) = append_line(&stub, url) {
            eprintln!(
                "vantail: could not record {url} in VANTAIL_OPEN_STUB: {error}"
            );
        }
        return;
    }
    if let Err(error) = open::that_detached(url) {
        eprintln!("vantail: could not open {url}: {error}");
    }
}

/// `bridge.*`: what the injected bridge asks for on the page's behalf. Not
/// part of `@vantail/api`.
///
/// `bridge.openLink` is a link to another site, clicked in the page: it goes
/// to the browser instead of taking the application's window with it. No
/// permission, for the same reason a browser asks none - it is what clicking
/// a link does - and only for what `target="_blank"` could already reach:
/// a web page or a mail link that is not the application's own.
pub fn dispatch(
    rt: &Runtime,
    method: &str,
    params: serde_json::Value,
) -> crate::error::ApiResult {
    #[derive(serde::Deserialize)]
    struct OpenLink {
        url: String,
    }

    match method {
        "bridge.openLink" => {
            let OpenLink { url } = crate::ipc::Request::params(method, params)?;
            leaves_for_the_system(&Origins::new(rt), &url)?;
            open_externally(&url);
            Ok(serde_json::Value::Null)
        }
        _ => Err(crate::error::ApiError::unknown_method(method)),
    }
}

/// Whether `bridge.openLink` may hand `url` over. The page can call it
/// directly, so what the bridge would never send is refused here as well.
fn leaves_for_the_system(
    origins: &Origins,
    url: &str,
) -> Result<(), crate::error::ApiError> {
    if opens_externally(url) && !origins.allows(url) {
        Ok(())
    } else {
        Err(crate::error::ApiError::new(
            crate::error::code::INVALID_ARGUMENT,
            format!("`{url}` is not a link to another site"),
        ))
    }
}

/// Put a window's title bar metrics into a page that is already running.
///
/// The same three variables the bridge sets at startup, and the same object
/// `titleBarMetrics()` reads - so a toolbar built from either stays correct
/// when the style is switched at runtime.
pub fn title_bar_script(metrics: crate::chrome::titlebar::Metrics) -> String {
    format!(
        r#"(function () {{
  var metrics = {metrics};
  if (window.__VANTAIL__) window.__VANTAIL__.titleBar = metrics;
  var root = document.documentElement;
  if (root) {{
    root.style.setProperty('--vantail-titlebar-height', metrics.height + 'px');
    root.style.setProperty('--vantail-titlebar-inset-left', metrics.insetLeft + 'px');
    root.style.setProperty('--vantail-titlebar-inset-right', metrics.insetRight + 'px');
    root.style.setProperty('--vantail-titlebar-button-top', metrics.buttonTop + 'px');
    root.style.setProperty('--vantail-titlebar-button-height', metrics.buttonHeight + 'px');
  }}
}})();"#,
        metrics = json!(metrics)
    )
}

/// Makes the window a fixed frame rather than a page.
///
/// Three things, and they are all furniture rather than behaviour: the
/// document does not scroll, it does not rubber-band past its edges, and the
/// scrollbars are gone. Panes inside still scroll, because their own
/// `overflow` says so - only the document is pinned.
///
/// `scrollbar-width` is the standard property and `::-webkit-scrollbar` is
/// what the platform webviews actually read, so both are set. `revert` puts
/// the user agent's own back for a subtree that asked for it.
///
/// Appended to `<html>` at document-start, before the page's own stylesheets
/// are parsed, so an application that disagrees simply wins.
const FIXED_FRAME: &str = "\
html, body { overflow: hidden; overscroll-behavior: none; }\n\
* { scrollbar-width: none; }\n\
::-webkit-scrollbar { width: 0; height: 0; }\n\
[data-vantail-scrollbar], [data-vantail-scrollbar] * { scrollbar-width: auto; }\n\
[data-vantail-scrollbar]::-webkit-scrollbar,\n\
[data-vantail-scrollbar] *::-webkit-scrollbar { width: revert; height: revert; }\n";

/// The bridge, injected before any page script runs.
///
/// It deliberately knows nothing about methods or promises - it is a pipe.
/// `@vantail/api` subscribes to it and builds the typed surface on top, so
/// the protocol can grow without the runtime shipping a new bridge.
// Nearly all of this is the bridge's JavaScript, which is one template: its
// pieces share variables, and splitting it across functions would make the
// script harder to follow, not easier.
#[allow(clippy::too_many_lines)]
pub fn init_script(
    rt: &Runtime,
    label: &str,
    origins: &Origins,
    title_bar: crate::chrome::titlebar::Metrics,
    scroll: bool,
) -> String {
    let own = json!(origins.as_seen_by_page());
    let app = json!({
        "name": rt.config.app.name,
        "version": rt.config.app.version,
        "identifier": rt.config.app.identifier,
        "isDev": rt.is_dev(),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    });

    let title_bar = json!(title_bar);

    format!(
        r#"(function () {{
  if (window.__VANTAIL__) return;
  // Somebody else's page, reached by a link or a redirect. The runtime would
  // refuse its calls anyway; this keeps the application's details out of it.
  if ({own}.indexOf(location.protocol + '//' + location.host) < 0) return;

  var listeners = new Set();
  var backlog = [];
  // Requests the bridge makes for itself. Their replies are not anybody's
  // business, and without this they would pile up in `backlog` forever on a
  // page that never loads the SDK - which is exactly the page that most needs
  // the window to be draggable.
  var ours = new Set();
  var seq = 0;

  // The room a hidden title bar left behind, in the page before it lays out -
  // so a toolbar sized from it never has to flash at the wrong height, and
  // nobody has to hardcode a number that differs per platform.
  var metrics = {title_bar};
  function applyMetrics() {{
    var root = document.documentElement;
    if (!root) return false;
    root.style.setProperty('--vantail-titlebar-height', metrics.height + 'px');
    root.style.setProperty('--vantail-titlebar-inset-left', metrics.insetLeft + 'px');
    root.style.setProperty('--vantail-titlebar-inset-right', metrics.insetRight + 'px');
    root.style.setProperty('--vantail-titlebar-button-top', metrics.buttonTop + 'px');
    root.style.setProperty('--vantail-titlebar-button-height', metrics.buttonHeight + 'px');
    return true;
  }}
  // A window is a fixed frame unless it asked to be a page: the document does
  // not scroll, does not rubber-band, and has no scrollbars. Panes inside it
  // still scroll on their own `overflow`.
  var frameCss = {frame_css};
  function applyFrame() {{
    var root = document.documentElement;
    if (!root) return false;
    if (!frameCss) return true;
    var style = document.createElement('style');
    style.setAttribute('data-vantail', 'frame');
    style.textContent = frameCss;
    root.appendChild(style);
    return true;
  }}

  // At document-start `<html>` normally exists already; when it does not,
  // this runs as soon as the parser has made it.
  if (!applyMetrics() || !applyFrame()) {{
    document.addEventListener('DOMContentLoaded', function () {{
      applyMetrics();
      applyFrame();
    }}, {{ once: true }});
  }}

  window.__VANTAIL__ = {{
    version: {runtime_version},
    app: {app},
    label: {label},
    titleBar: {title_bar},

    postMessage: function (message) {{
      window.ipc.postMessage(JSON.stringify(message));
    }},

    subscribe: function (listener) {{
      listeners.add(listener);
      // Anything that arrived before the SDK loaded is delivered on the next
      // microtask rather than right now: a page typically subscribes and then
      // registers its handlers, and delivering in between would drop exactly
      // the messages that were saved for it.
      if (backlog.length) {{
        Promise.resolve().then(function () {{
          var pending = backlog;
          backlog = [];
          for (var i = 0; i < pending.length; i++) {{
            listeners.forEach(function (target) {{
              try {{
                target(pending[i]);
              }} catch (error) {{
                console.error('[vantail] a message listener threw', error);
              }}
            }});
          }}
        }});
      }}
      return function () {{ listeners.delete(listener); }};
    }},

    _dispatch: function (message) {{
      if (message && ours.has(message.id)) {{
        ours.delete(message.id);
        return;
      }}
      if (listeners.size === 0) {{
        backlog.push(message);
        return;
      }}
      listeners.forEach(function (listener) {{
        try {{
          listener(message);
        }} catch (error) {{
          console.error('[vantail] a message listener threw', error);
        }}
      }});
    }}
  }};

  // Moving the window
  //
  // A window whose title bar is hidden has nothing left to drag it by, and
  // `-webkit-app-region: drag` is a Chromium extension that does nothing in
  // the platform webviews. Every application therefore ended up writing the
  // same `pointerdown` handler, and an application that drew no bar at all -
  // just the platform's window buttons over its own page - could not be moved
  // at all until somebody noticed.
  //
  // So the bridge does it. Two things drag the window:
  //
  //   * the band the hidden bar left behind, which is `metrics.height` and is
  //     zero when the platform is still drawing a real bar - there is nothing
  //     to stand in for then;
  //   * anything inside `[data-vantail-drag]`, for chrome that is taller than
  //     that band or somewhere else entirely.
  //
  // Controls are excluded, because a pointer down that begins a window drag
  // never becomes a click on the button underneath it. `[data-vantail-no-drag]`
  // opts out anything else - put it on `<body>` to opt out of the lot - and so
  // does calling `preventDefault()` on the event, which is how an application
  // that would rather do this itself keeps the bridge out of the way.
  function ask(method, params) {{
    var id = 'vantail:' + (seq++);
    ours.add(id);
    window.ipc.postMessage(JSON.stringify({{ id: id, method: method, params: params || {{}} }}));
  }}

  var KEEPS_THE_POINTER =
    'button,input,select,textarea,a[href],label,summary,video,audio,' +
    '[contenteditable],[draggable=true],[role=button],[role=link],[role=menu],' +
    '[role=menuitem],[role=tab],[role=slider],[role=textbox],[data-vantail-no-drag]';

  function movesTheWindow(event) {{
    if (event.button !== 0 || event.defaultPrevented) return false;

    var target = event.target;
    // Text nodes and anything outside an element tree have no `closest`.
    if (!target || typeof target.closest !== 'function') return false;
    if (target.closest(KEEPS_THE_POINTER)) return false;
    if (target.closest('[data-vantail-drag]')) return true;

    return metrics.height > 0 && event.clientY < metrics.height;
  }}

  // On the bubble rather than the capture phase, so an application's own
  // handler runs first and can call `preventDefault()` to be left alone.
  document.addEventListener('pointerdown', function (event) {{
    if (movesTheWindow(event)) ask('window.startDragging');
  }});

  // What a real title bar does on a double click, and the platform will not do
  // it for a bar that is not there.
  document.addEventListener('dblclick', function (event) {{
    if (movesTheWindow(event)) ask('window.toggleMaximize');
  }});

  // A link to another site, followed in place, would take the application's
  // whole window with it, and nothing on that page leads back. It goes to the
  // browser instead - the same place a `target="_blank"` link goes.
  //
  // On `window`, after the bubble has passed `document`, so a router that
  // handled the click itself has called `preventDefault()` by then. Links the
  // page aims somewhere on purpose - another frame, a download - are left
  // alone, and so is everything within the application's own origin.
  window.addEventListener('click', function (event) {{
    if (event.defaultPrevented || event.button !== 0) return;
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    var link = target.closest('a[href]');
    if (!link || link.hasAttribute('download')) return;
    var aim = (link.getAttribute('target') || '').toLowerCase();
    if (aim && aim !== '_self' && aim !== '_top' && aim !== '_parent') return;

    var url;
    try {{
      url = new URL(link.href);
    }} catch (error) {{
      return;
    }}
    if (['http:', 'https:', 'mailto:'].indexOf(url.protocol) < 0) return;
    if ({own}.indexOf(url.protocol + '//' + url.host) >= 0) return;

    event.preventDefault();
    ask('bridge.openLink', {{ url: url.href }});
  }});
}})();"#,
        runtime_version = json!(env!("CARGO_PKG_VERSION")),
        app = app,
        label = json!(label),
        frame_css = json!(if scroll { "" } else { FIXED_FRAME }),
    )
}

/// The resource directory, resolved once.
///
/// Every asset request used to canonicalise the root again, which is two
/// syscalls per file on a path that runs for every script, stylesheet and
/// image a page loads. It cannot change while the application is running.
pub struct Resources {
    root: PathBuf,
}

impl Resources {
    pub fn new(root: &Path) -> Self {
        Self {
            root: match root.canonicalize() {
                Ok(canonical) => canonical,
                Err(_) => root.to_path_buf(),
            },
        }
    }

    pub fn serve(
        &self,
        request: &Request<Vec<u8>>,
    ) -> Response<Cow<'static, [u8]>> {
        serve(&self.root, request)
    }
}

/// Serve `vantail://` requests from the app's resource directory.
pub fn serve(
    root: &Path,
    request: &Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    if request.method() != "GET" {
        return status(StatusCode::METHOD_NOT_ALLOWED, "Only GET is supported");
    }

    let raw_path = request.uri().path();
    let decoded = percent_decode_str(raw_path).decode_utf8_lossy();
    let requested = decoded.trim_start_matches('/');

    let target = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };

    let Some(file) = resolve(root, target) else {
        return status(
            StatusCode::FORBIDDEN,
            "That path is outside the application's resources",
        );
    };

    if let Ok(bytes) = std::fs::read(&file) {
        return ok(&file, bytes);
    }

    // A path with no extension is almost always a client-side route, so fall
    // back to the shell document and let the router handle it.
    if Path::new(target).extension().is_none() {
        if let Some(response) = shell_document(root) {
            return response;
        }
    }
    status(StatusCode::NOT_FOUND, &format!("Not found: /{target}"))
}

/// The application's `index.html`, if it has one.
fn shell_document(root: &Path) -> Option<Response<Cow<'static, [u8]>>> {
    let index = resolve(root, "index.html")?;
    let Ok(bytes) = std::fs::read(&index) else {
        return None;
    };
    Some(ok(&index, bytes))
}

/// Resolve a request path inside `root`, or `None` if it escapes.
///
/// `root` is expected to be canonical already - [`Resources`] does that once.
fn resolve(root: &Path, requested: &str) -> Option<PathBuf> {
    let root = root.to_path_buf();
    let mut candidate = root.clone();

    // Build the path component by component so `..` can never climb above the
    // resource root, whether or not the file exists.
    for component in Path::new(requested).components() {
        use std::path::Component;
        match component {
            Component::Normal(part) => candidate.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !candidate.pop() || !candidate.starts_with(&root) {
                    return None;
                }
            }
            // A rooted or prefixed component in a URL path is never legitimate.
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }

    let candidate = match candidate.canonicalize() {
        Ok(canonical) => canonical,
        Err(_) => candidate,
    };
    if candidate.starts_with(&root) {
        Some(candidate)
    } else {
        None
    }
}

fn ok(path: &Path, bytes: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let content_type = if mime.type_() == mime_guess::mime::TEXT
        || mime.essence_str() == "application/javascript"
        || mime.essence_str() == "application/json"
    {
        format!("{mime}; charset=utf-8")
    } else {
        mime.to_string()
    };

    let mut response = Response::new(Cow::Owned(bytes));
    let headers = response.headers_mut();
    // A guessed type is always a valid header value; one that somehow is not
    // goes out as plain bytes rather than failing the request.
    let content_type = match HeaderValue::from_str(&content_type) {
        Ok(value) => value,
        Err(_) => HeaderValue::from_static("application/octet-stream"),
    };
    headers.insert(header::CONTENT_TYPE, content_type);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    response
}

fn status(code: StatusCode, message: &str) -> Response<Cow<'static, [u8]>> {
    let mut response = Response::new(Cow::Owned(message.as_bytes().to_vec()));
    *response.status_mut() = code;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory of this test's own.
    ///
    /// Shared before, which raced: `cargo test` runs these in parallel, and
    /// one test truncating `index.html` while another read it made the suite
    /// fail about once in a hundred runs.
    fn root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("vantail-protocol-test-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("assets")).expect("scratch root");
        std::fs::write(root.join("index.html"), b"<!doctype html>")
            .expect("index.html");
        std::fs::write(root.join("assets/app.js"), b"export {}")
            .expect("app.js");
        root.canonicalize().expect("canonical scratch root")
    }

    #[test]
    fn serves_files_from_the_resource_directory() {
        let root = root("serves_files_from_the_resource_directory");
        assert!(resolve(&root, "index.html").is_some());
        assert!(resolve(&root, "assets/app.js").is_some());
    }

    #[test]
    fn refuses_to_climb_out_of_the_resource_directory() {
        let root = root("refuses_to_climb_out_of_the_resource_directory");
        assert_eq!(resolve(&root, "../../etc/passwd"), None);
        assert_eq!(resolve(&root, "assets/../../../etc/passwd"), None);
        assert_eq!(resolve(&root, "/etc/passwd"), None);
    }

    #[test]
    fn parent_segments_are_fine_while_they_stay_inside() {
        let root = root("parent_segments_are_fine_while_they_stay_inside");
        assert_eq!(
            resolve(&root, "assets/../index.html"),
            Some(root.join("index.html"))
        );
    }

    #[test]
    fn an_unknown_route_falls_back_to_the_shell_document() {
        let root = root("an_unknown_route_falls_back_to_the_shell_document");
        let request = Request::builder()
            .method("GET")
            .uri("vantail://localhost/settings/profile")
            .body(Vec::new())
            .expect("request");

        let response = serve(&root, &request);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body().as_ref(), b"<!doctype html>");
    }

    #[test]
    fn a_missing_asset_is_a_404_rather_than_the_shell_document() {
        let root =
            root("a_missing_asset_is_a_404_rather_than_the_shell_document");
        let request = Request::builder()
            .method("GET")
            .uri("vantail://localhost/assets/missing.js")
            .body(Vec::new())
            .expect("request");

        assert_eq!(serve(&root, &request).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn the_root_path_serves_index_html() {
        let root = root("the_root_path_serves_index_html");
        let request = Request::builder()
            .method("GET")
            .uri("vantail://localhost/")
            .body(Vec::new())
            .expect("request");

        let response = serve(&root, &request);
        assert_eq!(response.status(), StatusCode::OK);
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .expect("a content type");
        assert!(content_type
            .to_str()
            .expect("a readable content type")
            .starts_with("text/html"));
    }

    #[test]
    fn the_applications_own_pages_are_trusted_wherever_they_route() {
        let origins = Origins::with_dev(None);
        assert!(origins.allows(&app_url("index.html")));
        assert!(origins.allows(&app_url("settings/profile?tab=2#top")));
    }

    #[test]
    fn a_page_from_anywhere_else_is_refused() {
        let origins = Origins::with_dev(None);
        for url in [
            "https://example.com/",
            "http://example.com/",
            // Look-alikes of the application's own origin.
            "http://vantail.localhost.example.com/",
            "https://vantail.localhost/",
            "vantail://example.com/",
            "http://localhost/",
        ] {
            assert!(!origins.allows(url), "{url} was trusted");
        }
    }

    #[test]
    fn the_dev_server_is_trusted_only_in_development() {
        let dev = Origins::with_dev(Some("http://localhost:5173"));
        assert!(dev.allows("http://localhost:5173/"));
        assert!(dev.allows("http://LOCALHOST:5173/src/main.tsx"));
        assert!(!dev.allows("http://localhost:5174/"));
        assert!(!dev.allows("http://127.0.0.1:5173/"));

        let packaged = Origins::with_dev(None);
        assert!(!packaged.allows("http://localhost:5173/"));
    }

    #[test]
    fn a_default_port_is_the_same_origin_as_none() {
        let origins = Origins::with_dev(Some("http://localhost"));
        assert!(origins.allows("http://localhost:80/"));
        assert!(!origins.allows("https://localhost/"));
    }

    #[test]
    fn a_page_with_no_origin_is_not_the_application() {
        let origins = Origins::with_dev(Some("http://127.0.0.1:5173"));
        for url in [
            // Between loads.
            "about:blank",
            "",
            "not a url",
            // Scriptable, and with no host for the comparison: a page can
            // navigate itself to one of these and keep running. Nothing may
            // be pushed into it, so it is not the application's own.
            "data:text/html,<script>alert(1)</script>",
            "blob:http://127.0.0.1:5173/1b6a2f7c",
        ] {
            assert!(!origins.allows(url), "{url} was trusted");
        }
        // Its creator's origin is still trusted; it is the blob document,
        // which has no host of its own, that is nobody the runtime knows.
        assert!(origins.allows("http://127.0.0.1:5173/evil"));
    }

    #[test]
    fn the_bridge_sees_the_origins_the_way_the_page_spells_them() {
        let origins = Origins::with_dev(Some("http://LocalHost:5173/"));
        let app = if cfg!(target_os = "windows") {
            "http://vantail.localhost"
        } else {
            "vantail://localhost"
        };
        assert_eq!(
            origins.as_seen_by_page(),
            vec![app.to_string(), "http://localhost:5173".to_string()]
        );
        // A default port is left out, as `location.host` leaves it out.
        let plain = Origins::with_dev(Some("https://dev.example:443"));
        assert_eq!(plain.as_seen_by_page()[1], "https://dev.example");
    }

    #[test]
    fn a_link_out_is_only_ever_another_site() {
        let origins = Origins::with_dev(Some("http://localhost:5173"));
        assert!(
            leaves_for_the_system(&origins, "https://example.com/docs").is_ok()
        );
        assert!(
            leaves_for_the_system(&origins, "mailto:someone@example.com")
                .is_ok()
        );
        for url in [
            // The application's own pages stay in the window.
            &app_url("settings.html"),
            "http://localhost:5173/settings",
            // Nothing a browser would not open from a link.
            "file:///etc/passwd",
            "javascript:alert(1)",
            "vantail://localhost/",
        ] {
            let refused = leaves_for_the_system(&origins, url).expect_err(url);
            assert_eq!(refused.code, crate::error::code::INVALID_ARGUMENT);
        }
    }

    #[test]
    fn only_web_pages_and_mail_links_leave_for_the_system() {
        assert!(opens_externally("https://example.com/"));
        assert!(opens_externally("HTTP://example.com/"));
        assert!(opens_externally("mailto:someone@example.com"));
        assert!(!opens_externally("file:///etc/passwd"));
        assert!(!opens_externally("javascript:alert(1)"));
        assert!(!opens_externally("vantail://localhost/"));
        assert!(!opens_externally("about:blank"));
    }
}
