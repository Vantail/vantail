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
use wry::http::{header, Request, Response, StatusCode};

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

/// The bridge, injected before any page script runs.
///
/// It deliberately knows nothing about methods or promises - it is a pipe.
/// `@vantail/api` subscribes to it and builds the typed surface on top, so
/// the protocol can grow without the runtime shipping a new bridge.
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

pub fn init_script(
    rt: &Runtime,
    label: &str,
    title_bar: crate::chrome::titlebar::Metrics,
    scroll: bool,
) -> String {
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
  function ask(method) {{
    var id = 'vantail:' + (seq++);
    ours.add(id);
    window.ipc.postMessage(JSON.stringify({{ id: id, method: method, params: {{}} }}));
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
            root: root.canonicalize().unwrap_or_else(|_| root.to_path_buf()),
        }
    }

    pub fn serve(&self, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
        serve(&self.root, request)
    }
}

/// Serve `vantail://` requests from the app's resource directory.
pub fn serve(root: &Path, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
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

    match std::fs::read(&file) {
        Ok(bytes) => ok(&file, bytes),
        Err(_) => {
            // A path with no extension is almost always a client-side route,
            // so fall back to the shell document and let the router handle it.
            if Path::new(target).extension().is_none() {
                if let Some(index) = resolve(root, "index.html") {
                    if let Ok(bytes) = std::fs::read(&index) {
                        return ok(&index, bytes);
                    }
                }
            }
            status(StatusCode::NOT_FOUND, &format!("Not found: /{target}"))
        }
    }
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

    let candidate = candidate.canonicalize().unwrap_or(candidate);
    candidate.starts_with(&root).then_some(candidate)
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

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Cow::Owned(bytes))
        .expect("response builder inputs are valid")
}

fn status(code: StatusCode, message: &str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(code)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Cow::Owned(message.as_bytes().to_vec()))
        .expect("response builder inputs are valid")
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
        let root = std::env::temp_dir().join(format!("vantail-protocol-test-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("assets")).expect("scratch root");
        std::fs::write(root.join("index.html"), b"<!doctype html>").expect("index.html");
        std::fs::write(root.join("assets/app.js"), b"export {}").expect("app.js");
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
        let root = root("a_missing_asset_is_a_404_rather_than_the_shell_document");
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
        assert!(response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/html")));
    }
}
