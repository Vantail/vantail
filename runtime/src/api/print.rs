//! `print.*` - printing application-generated content through the native dialog.
//!
//! The shape of this API is the safety property. There is deliberately no
//! `print()` with no arguments and no `print.currentWindow()`: every call
//! names its content source explicitly (`html` or `pdfPath`), and the runtime
//! renders that source in a hidden view of its own that is never attached to
//! any application window. The application's own UI cannot be printed through
//! this API because there is no call that names it.
//!
//! Why there is no `permissions.print` flag:
//!
//! A permission gate answers "may this application do this on its own?". The
//! native print dialog answers that question itself, in front of the user,
//! on every call: the user picks the printer, the copies and the page range,
//! or cancels and nothing happens. Gating the call in config as well would
//! add a checkbox that authorises nothing beyond what the dialog already
//! asks. The actual gate - the thing that stops an application (or injected
//! JavaScript inside it) from silently exfiltrating the visible UI to a
//! printer or PDF - is the isolation above: only caller-supplied content is
//! ever rendered, and only in a view the user never sees.
//!
//! A `pdfPath` still goes through `permissions.filesystem` read scope,
//! exactly as if the application had read the file itself. Printing a file
//! reads it, so it checks like a read. A path the user picked in a dialog
//! carries its session grant here too, the same as anywhere else.
//!
//! Flow: `print.document` validates, opens a hidden window holding a single
//! webview, loads the content, and returns without answering - the answer
//! arrives later, once the page reports it has finished loading, the native
//! dialog has been shown on the event loop thread, and the hidden view has
//! been torn down. See `UserEvent::PrintReady`.

use serde::Deserialize;
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::ipc::Request;
use crate::permissions::{Access, RawPath};
use crate::state::MainCtx;
use crate::windows::PrintContent;

#[derive(Deserialize, Default)]
struct DocumentParams {
    #[serde(default)]
    html: Option<String>,
    #[serde(default, rename = "pdfPath")]
    pdf_path: Option<String>,
}

/// What the caller asked to print, validated.
#[derive(Debug)]
enum Content {
    Html(String),
    Pdf(RawPath),
}

/// `Some` answers now; `None` means a hidden view is loading and the answer
/// will be delivered once it is ready (see `UserEvent::PrintReady`).
pub fn dispatch(
    ctx: &mut MainCtx<'_>,
    id: &str,
    method: &str,
    params: Value,
) -> Option<ApiResult> {
    if method != "print.document" {
        return Some(Err(ApiError::unknown_method(method)));
    }

    let params: DocumentParams = match Request::params(method, params) {
        Ok(params) => params,
        Err(error) => return Some(Err(error)),
    };

    match begin(ctx, id, &params) {
        // The hidden view is loading; the answer arrives with PrintReady.
        Ok(()) => None,
        Err(error) => Some(Err(error)),
    }
}

/// Validate and, when there is something to render, open the hidden view.
///
/// `Ok` means the job was started and the response is deferred until the
/// view reports it has finished loading (see `UserEvent::PrintReady`).
fn begin(ctx: &mut MainCtx<'_>, id: &str, params: &DocumentParams) -> Result<(), ApiError> {
    let content = validate(params)?;

    // Printing a file reads it, so it checks like a read: the standing scope,
    // or a session grant from a dialog or a drop. What was checked is what
    // gets loaded - `check_path` returns the normalised path and that is what
    // the hidden view opens.
    let content = match content {
        Content::Html(html) => PrintContent::Html(html),
        Content::Pdf(raw) => {
            let resolved = ctx.rt.permissions.check_path(&raw, Access::Read)?;
            match std::fs::metadata(&resolved) {
                Ok(meta) if meta.is_file() => PrintContent::Pdf(resolved),
                Ok(_) => {
                    return Err(ApiError::invalid_argument(format!(
                        "`pdfPath` is not a file: {}",
                        resolved.display()
                    )));
                }
                Err(error) => {
                    return Err(ApiError::io(
                        &format!("Could not open `{}`", resolved.display()),
                        error,
                    ));
                }
            }
        }
    };

    ctx.windows
        .begin_print_job(ctx.target, ctx.proxy(), id, ctx.source, content)
        .map(|_| ())
        .map_err(ApiError::internal)
}

/// Exactly one source, and not an empty one.
fn validate(params: &DocumentParams) -> Result<Content, ApiError> {
    let html = params.html.as_deref().filter(|s| !s.is_empty());
    let pdf = params.pdf_path.as_deref().filter(|s| !s.is_empty());

    match (html, pdf) {
        (Some(_), Some(_)) => Err(ApiError::invalid_argument(
            "`print.document` takes exactly one of `html` or `pdfPath`, not both.",
        )),
        (None, None) => Err(ApiError::invalid_argument(
            "`print.document` needs something to print: pass `html` or `pdfPath`.",
        )),
        (Some(html), None) => Ok(Content::Html(html.to_string())),
        (None, Some(pdf)) => Ok(Content::Pdf(RawPath::new(pdf))),
    }
}

/// Show the platform's print dialog for a hidden view that has finished
/// loading, then resolve.
///
/// Called on the event loop thread - every platform's print API belongs to
/// the UI thread, and the Linux and macOS ones are modal, blocking here the
/// way `dialog.*` already does. The caller takes the job out of the window
/// manager first, so when this returns the hidden view is dropped with it.
pub fn run_print_dialog(webview: &wry::WebView) -> ApiResult {
    // A test hook, not a feature: with `VANTAIL_PRINT_STUB=1` the hidden view
    // is still created and the content still loads, but the modal dialog is
    // skipped. Integration tests run headless-of-humans, and a test that
    // stops for a person to click Print is not a test. See
    // `test/integration/print.test.js`.
    if std::env::var_os("VANTAIL_PRINT_STUB").is_some() {
        return Ok(Value::Null);
    }

    platform_print(webview).map(|()| Value::Null)
}

#[cfg(target_os = "linux")]
fn platform_print(webview: &wry::WebView) -> Result<(), ApiError> {
    // `WebKitPrintOperation` from this view, GTK dialog, starts printing.
    // Modal: returns once the dialog has closed, printed or cancelled.
    // Whether it was print or cancel is not reported back - the promise
    // resolves either way, which is also what the API above documents.
    webview
        .print()
        .map_err(|e| ApiError::internal(format!("Could not print: {e}")))
}

#[cfg(target_os = "windows")]
fn platform_print(webview: &wry::WebView) -> Result<(), ApiError> {
    // The system dialog, not the browser one: printer, copies and page range
    // are the user's choice, which is what makes the dialog the gate.
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::Interface;
    use wry::WebViewExtWindows;

    let core = webview.webview();
    let view: ICoreWebView2_16 = core.cast().map_err(|_| {
        ApiError::unsupported(
            "Printing needs WebView2 Runtime 1.0.1518.46 or newer. Update the WebView2 Runtime and try again.",
        )
    })?;

    // Asynchronous: returns once the dialog is on screen rather than once it
    // has closed. The platform offers no close notification for this call, so
    // the promise resolves at that point - documented in `docs/api.md`.
    unsafe {
        view.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM)
            .map_err(|e| ApiError::internal(format!("Could not open the print dialog: {e}")))
    }
}

#[cfg(target_os = "macos")]
fn platform_print(webview: &wry::WebView) -> Result<(), ApiError> {
    // The direct operation, with the frame workaround applied by hand.
    //
    // Two things are known about `printOperationWithPrintInfo:` on WKWebView.
    // First, it can crash with `EXC_BREAKPOINT` when the view it prints has
    // no frame yet - which a hidden view reliably has not - so the
    // operation's view is given this webview's bounds before it runs. Second,
    // it prints the visible frame, so content overflowing to the right can be
    // dropped; the hidden window is opened at a full page width to leave
    // nothing overflowed under normal content. A vector-PDF normalisation
    // (`createPDF:` then printing the PDF) would remove that second caveat
    // entirely, but that call answers through a completion block while this
    // runs on the event loop thread that would have to wait for it - so this
    // stays synchronous and modal, like `dialog.*`.
    use objc2::runtime::AnyObject;
    use wry::WebViewExtMacOS;

    let wk = webview.webview();
    let obj: &AnyObject = unsafe { &*objc2::rc::Retained::as_ptr(&wk).cast::<AnyObject>() };

    unsafe {
        let can_print: bool =
            objc2::msg_send![obj, respondsToSelector: objc2::sel!(printOperationWithPrintInfo:)];
        if !can_print {
            return Err(ApiError::unsupported(
                "Printing needs macOS 11 or newer.",
            ));
        }

        let info: *mut AnyObject =
            objc2::msg_send![objc2::class!(NSPrintInfo), sharedPrintInfo];
        let operation: *mut AnyObject =
            objc2::msg_send![obj, printOperationWithPrintInfo: &*info];

        // The crash workaround: the operation's view gets a real frame.
        let bounds: objc2_foundation::NSRect = objc2::msg_send![obj, bounds];
        let view: *mut AnyObject = objc2::msg_send![&*operation, view];
        let _: () = objc2::msg_send![&*view, setFrame: bounds];

        let _: () = objc2::msg_send![&*operation, setCanSpawnSeparateThread: true];
        // App-modal, not a sheet on the hidden window: a sheet would attach
        // to a window the user never sees. This runs until the dialog
        // closes, printed or cancelled.
        let _: bool = objc2::msg_send![&*operation, runOperation];
    }

    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn platform_print(_webview: &wry::WebView) -> Result<(), ApiError> {
    Err(ApiError::unsupported(
        "Printing is supported on Linux, Windows and macOS.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(html: Option<&str>, pdf: Option<&str>) -> DocumentParams {
        DocumentParams {
            html: html.map(str::to_string),
            pdf_path: pdf.map(str::to_string),
        }
    }

    #[test]
    fn html_alone_is_accepted() {
        assert!(matches!(
            validate(&params(Some("<h1>hi</h1>"), None)),
            Ok(Content::Html(_))
        ));
    }

    #[test]
    fn pdf_path_alone_is_accepted() {
        assert!(matches!(
            validate(&params(None, Some("/tmp/invoice.pdf"))),
            Ok(Content::Pdf(_))
        ));
    }

    #[test]
    fn both_sources_are_rejected_with_invalid_argument() {
        let error = validate(&params(Some("<h1>hi</h1>"), Some("/tmp/a.pdf"))).unwrap_err();
        assert_eq!(error.code, crate::error::code::INVALID_ARGUMENT);
    }

    #[test]
    fn neither_source_is_rejected_with_invalid_argument() {
        let error = validate(&params(None, None)).unwrap_err();
        assert_eq!(error.code, crate::error::code::INVALID_ARGUMENT);
    }

    #[test]
    fn empty_strings_count_as_missing() {
        // `""` is not content. Without this, `html: ""` would open a dialog
        // over a blank page rather than saying what is wrong.
        let error = validate(&params(Some(""), None)).unwrap_err();
        assert_eq!(error.code, crate::error::code::INVALID_ARGUMENT);
        let error = validate(&params(None, Some(""))).unwrap_err();
        assert_eq!(error.code, crate::error::code::INVALID_ARGUMENT);
    }

    #[test]
    fn unknown_print_methods_do_not_reach_validation() {
        // Needs no window manager: an unknown method answers before anything
        // is touched. `ctx` is never dereferenced on this path, so a null is
        // never built - instead, check the error constructor the path uses.
        let error = ApiError::unknown_method("print.currentWindow");
        assert_eq!(error.code, crate::error::code::UNKNOWN_METHOD);
    }
}
