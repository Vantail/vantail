//! `print.document` - the native print dialog for application-generated content.
//!
//! There is deliberately **no `permissions.print` flag**, and there never
//! should be one. Two properties make a flag the wrong tool:
//!
//! 1. **The native dialog is the authorisation.** Nothing prints without a
//!    person choosing a printer, copies and a page range in a dialog the
//!    application cannot click through. A config flag would gate *reaching*
//!    that dialog, which is backwards: the dialog is the gate.
//! 2. **The application's own UI is unreachable.** Printing always renders an
//!    explicit `html` string or `pdfPath` file into a hidden webview that is
//!    never attached to any user-visible window. There is no argument-less
//!    `print()`, no `print.currentWindow()`, and the main webview is never
//!    even referenced here - so there is nothing a compromised page could aim
//!    at the user's printer that the user did not just approve.
//!
//! The flow mirrors `tauri-plugin-printer-v2` in structure (hidden view ->
//! render -> print -> destroy) without sharing code with it:
//!
//! 1. Validate: exactly one of `html` / `pdfPath` (`INVALID_ARGUMENT`).
//! 2. For `pdfPath`, resolve through `permissions.filesystem` read scope.
//!    Printing *reads* the file into the renderer, so it is a read like any
//!    other: an app scoped to `$APPDATA/**` cannot print `/etc/passwd`, while
//!    a file the user picked in a dialog prints because the dialog granted it.
//! 3. Create a hidden window and a webview inside it. It is never shown and
//!    never added to [`WindowManager`](crate::windows::WindowManager)'s
//!    window list, so it cannot be listed, focused or scripted from
//!    JavaScript.
//! 4. Load the content (`html` as a data URL, `pdfPath` as a file URL) and
//!    wait for `PageLoadEvent::Finished` - never print a half-rendered page.
//! 5. Invoke the platform-native print UI on that hidden webview.
//! 6. Tear the window down and answer `{ printed }` once the dialog closes.
//!
//! Jobs live in [`PrintState`], which hangs off the `WindowManager` rather
//! than `Runtime`: a job owns a `tao::Window` and a `wry::WebView`, neither
//! of which may leave the event loop thread, while everything in `Runtime`
//! must stay `Send`. Sharing is by `Rc`, which the compiler keeps honest.
//!
//! `VANTAIL_PRINT_STUB=1` renders but skips the dialog and answers
//! `{ printed: false }`. That is what the integration test sets: CI has no
//! printer and no person to click Print, and the test is about the IPC and
//! render path, not about a human choosing a printer.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{code, ApiError, ApiResult};
use crate::ipc::{Outgoing, Request, Response, UserEvent};
use crate::permissions::{Access, RawPath};
use crate::state::{MainCtx, Runtime};

/// How long a print job may take from dispatch to answer before it is failed.
const JOB_TIMEOUT: Duration = Duration::from_secs(60);

/// Grace period after load completion so the first paint lands before the
/// dialog captures the page. The print dialog blocks the event loop anyway.
const PAINT_GRACE: Duration = Duration::from_millis(250);

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
struct DocumentParams {
    html: Option<String>,
    pdf_path: Option<String>,
}

/// Which explicit source a validated call prints.
#[derive(Debug, PartialEq, Eq)]
enum Source {
    Html(String),
    PdfPath(String),
}

/// The core safety property, checked on both sides of the IPC boundary: the
/// content source is always explicit, so the app UI is never printable.
///
/// An empty string counts as absent - it names no content - so exactly one
/// non-empty source must be present.
fn split_source(params: &DocumentParams) -> Result<Source, ApiError> {
    let html = params.html.as_deref().filter(|s| !s.is_empty());
    let pdf = params.pdf_path.as_deref().filter(|s| !s.is_empty());
    match (html, pdf) {
        (Some(html), None) => Ok(Source::Html(html.to_string())),
        (None, Some(pdf)) => Ok(Source::PdfPath(pdf.to_string())),
        _ => Err(ApiError::new(
            code::INVALID_ARGUMENT,
            "Pass exactly one of `html` or `pdfPath`: \
             `print.document({ html })` or `print.document({ pdfPath })`.",
        )),
    }
}

#[derive(Clone, Copy)]
enum Phase {
    /// An `html` string is rendering. On macOS the next step is PDF capture;
    /// everywhere else the next step is the print dialog.
    Html,
    /// A PDF (from `pdfPath`, or captured from HTML on macOS) is rendering.
    Pdf,
    /// macOS only: `createPDF` is in flight; its completion block drives on.
    #[cfg(target_os = "macos")]
    Capturing,
}

pub(crate) struct PrintJob {
    // Declared before `window`: fields drop in declaration order, and the
    // webview holds a raw handle into the window it was built on.
    webview: wry::WebView,
    /// Owns the hidden window. Never read: its job is to keep the window
    /// alive until the entry drops, which is the teardown.
    #[allow(dead_code)]
    window: tao::window::Window,
    phase: Phase,
    request_id: String,
    source: String,
    stub: bool,
    /// Staged PDF from macOS capture, deleted on teardown.
    pdf_temp: Option<PathBuf>,
}

#[derive(Default)]
struct Jobs {
    next: Cell<u64>,
    live: RefCell<HashMap<u64, PrintJob>>,
}

/// Hidden print jobs, owned by the `WindowManager`.
///
/// `Clone` shares the table rather than copying it, so the page-load handler
/// and the macOS capture block (both `'static`) can reach the job they belong
/// to. Everything here runs on the event loop thread.
#[derive(Clone, Default)]
pub struct PrintState {
    inner: Rc<Jobs>,
}

impl PrintState {
    fn alloc(&self) -> u64 {
        let job = self.inner.next.get();
        self.inner.next.set(job + 1);
        job
    }

    fn insert(&self, job: u64, entry: PrintJob) {
        self.inner.live.borrow_mut().insert(job, entry);
    }

    /// Remove a job; whoever removes it owns the answer. `None` when someone
    /// else got there first (dialog closed, capture failed, timed out).
    pub fn take(&self, job: u64) -> Option<PrintJob> {
        self.inner.live.borrow_mut().remove(&job)
    }

    fn phase(&self, job: u64) -> Option<Phase> {
        self.inner.live.borrow().get(&job).map(|entry| entry.phase)
    }
}

/// `None` means the response arrives later, after the dialog has closed.
pub fn dispatch(ctx: &mut MainCtx<'_>, id: &str, method: &str, params: Value) -> Option<ApiResult> {
    match method {
        "print.document" => match document(ctx, id, params) {
            Ok(()) => None,
            Err(error) => Some(Err(error)),
        },
        _ => Some(Err(ApiError::unknown_method(method))),
    }
}

fn document(ctx: &mut MainCtx<'_>, id: &str, params: Value) -> Result<(), ApiError> {
    let params: DocumentParams = Request::params("print.document", params)?;
    let source = split_source(&params)?;

    let (phase, url) = match &source {
        Source::Html(html) => (Phase::Html, html_data_url(html)),
        Source::PdfPath(raw) => {
            // Printing reads the file into the renderer, so this is a read like
            // any other: the standing scope applies, and dialog/drop grants apply.
            let resolved = ctx
                .rt
                .permissions
                .check_path(&RawPath::new(raw.clone()), Access::Read)?;
            if !resolved.is_file() {
                return Err(ApiError::new(
                    code::NOT_FOUND,
                    format!("No PDF file at {}", resolved.display()),
                ));
            }
            (Phase::Pdf, file_url(&resolved))
        }
    };

    let stub = std::env::var_os("VANTAIL_PRINT_STUB").is_some();

    let window = tao::window::WindowBuilder::new()
        .with_visible(false)
        .with_title("Vantail Print")
        .build(ctx.target)
        .map_err(|e| ApiError::internal(format!("Could not create the print window: {e}")))?;

    let state = ctx.windows.print.clone();
    let handler_state = state.clone();
    let job = state.alloc();
    let rt = Arc::clone(ctx.rt);
    let request_id = id.to_string();
    let reply_to = ctx.source.to_string();

    let builder = wry::WebViewBuilder::new()
        .with_url(&url)
        // A hidden view still has to finish loading when the app is not
        // frontmost; the default policy can suspend exactly that.
        .with_background_throttling(wry::BackgroundThrottlingPolicy::Disabled)
        .with_on_page_load_handler(move |event, _url| {
            if matches!(event, wry::PageLoadEvent::Finished) {
                on_ready(&rt, &handler_state, job);
            }
        });

    // Linux builds the webview on tao's GTK container: from the window itself
    // it takes the X11 handle, which does not exist under Wayland.
    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let container = window
            .default_vbox()
            .ok_or_else(|| ApiError::internal("The print window has no GTK container"))?;
        builder
            .build_gtk(container)
            .map_err(|e| ApiError::internal(format!("Could not create the print view: {e}")))?
    };
    #[cfg(not(target_os = "linux"))]
    let webview = builder
        .build(&window)
        .map_err(|e| ApiError::internal(format!("Could not create the print view: {e}")))?;

    state.insert(
        job,
        PrintJob {
            webview,
            window,
            phase,
            request_id,
            source: reply_to,
            stub,
            pdf_temp: None,
        },
    );

    // A load that never finishes must not hang the caller's promise forever.
    // The watchdog only wins while the job is still rendering: the job is
    // taken before its dialog opens, so a person gets as long as they need.
    let proxy = ctx.proxy();
    std::thread::Builder::new()
        .name(format!("vantail-print-watchdog-{job}"))
        .spawn(move || {
            std::thread::sleep(JOB_TIMEOUT);
            // The loop is gone during shutdown; the answer has nowhere to go.
            let _ = proxy.send_event(UserEvent::PrintTimeout { job });
        })
        .map_err(|e| ApiError::internal(format!("Could not watch the print job: {e}")))?;

    Ok(())
}

/// A hidden view finished loading: advance the job.
fn on_ready(rt: &Arc<Runtime>, state: &PrintState, job: u64) {
    #[cfg(target_os = "macos")]
    match state.phase(job) {
        // HTML renders first, then is normalised through a vector PDF
        // (see `begin_pdf_capture` for why) before anything prints.
        Some(Phase::Html) => {
            begin_pdf_capture(rt, state, job);
            return;
        }
        // The capture owns its phase; the PDF navigation's own load event
        // arrives as `Pdf` and prints below.
        Some(Phase::Pdf) => {}
        Some(Phase::Capturing) | None => return,
    }

    // Let the first paint land so the dialog captures the page, not a blank.
    std::thread::sleep(PAINT_GRACE);

    // Take the job before the modal dialog runs: the watchdog can no longer
    // win it, and dropping the entry afterwards is the teardown.
    let Some(entry) = state.take(job) else {
        return;
    };
    if entry.stub {
        // Rendered, dialog skipped: the render path above still ran.
        answer(rt, entry, Ok(json!({ "printed": false })));
        return;
    }
    let result = platform_print(&entry.webview).map(|printed| json!({ "printed": printed }));
    answer(rt, entry, result);
}

/// Answer the caller's promise and tear the hidden view down.
pub fn answer(rt: &Arc<Runtime>, entry: PrintJob, result: ApiResult) {
    if let Some(temp) = &entry.pdf_temp {
        let _ = std::fs::remove_file(temp);
    }
    rt.send(
        Some(entry.source.clone()),
        Outgoing::Response(Response::from_result(entry.request_id.clone(), result)),
    );
    // `entry` drops here: the hidden webview goes before its window.
}

/// The watchdog's deadline passed while the job was still rendering.
pub fn timed_out(rt: &Arc<Runtime>, state: &PrintState, job: u64) {
    if let Some(entry) = state.take(job) {
        answer(
            rt,
            entry,
            Err(ApiError::internal(
                "Printing timed out waiting for the page to render",
            )),
        );
    }
}

fn html_data_url(html: &str) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    format!(
        "data:text/html;charset=utf-8,{}",
        utf8_percent_encode(html, NON_ALPHANUMERIC)
    )
}

fn file_url(path: &std::path::Path) -> String {
    use percent_encoding::{utf8_percent_encode, CONTROLS};
    const EXTRA: &percent_encoding::AsciiSet = &CONTROLS.add(b' ').add(b'#').add(b'?');
    let display = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    let display = {
        let forward = display.replace('\\', "/");
        if forward.starts_with("//") {
            forward
        } else {
            format!("/{forward}")
        }
    };
    format!("file://{}", utf8_percent_encode(&display, EXTRA))
}

/// Show the platform-native print UI for the hidden webview.
///
/// Runs on the event loop thread; every platform's dialog is modal, which is
/// what resolves the promise on close rather than on print.
#[cfg(target_os = "windows")]
fn platform_print(webview: &wry::WebView) -> Result<bool, ApiError> {
    platform_print_windows(webview)
}

/// Show the platform-native print UI for the hidden webview.
///
/// Runs on the event loop thread; every platform's dialog is modal, which is
/// what resolves the promise on close rather than on print.
#[cfg(target_os = "macos")]
fn platform_print(webview: &wry::WebView) -> Result<bool, ApiError> {
    platform_print_macos(webview)
}

/// Show the platform-native print UI for the hidden webview.
///
/// Runs on the event loop thread; every platform's dialog is modal, which is
/// what resolves the promise on close rather than on print.
#[cfg(target_os = "linux")]
fn platform_print(webview: &wry::WebView) -> Result<bool, ApiError> {
    platform_print_linux(webview)
}

/// Show the platform-native print UI for the hidden webview.
///
/// Runs on the event loop thread; every platform's dialog is modal, which is
/// what resolves the promise on close rather than on print.
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn platform_print(webview: &wry::WebView) -> Result<bool, ApiError> {
    let _ = webview;
    Err(ApiError::unsupported(
        "Printing is not supported on this platform",
    ))
}

/// Windows: the system print dialog on the hidden WebView2.
///
/// `ShowPrintUI` needs `ICoreWebView2_16`, i.e. WebView2 Runtime
/// >= 1.0.1518.46. When the cast fails the runtime is older and the call
/// answers `UNSUPPORTED` rather than printing through a lesser dialog.
#[cfg(target_os = "windows")]
fn platform_print_windows(webview: &wry::WebView) -> Result<bool, ApiError> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM,
    };
    use windows::core::Interface;
    use wry::WebViewExtWindows;

    let core = webview.webview();
    let print: ICoreWebView2_16 = core.cast().map_err(|_| {
        ApiError::unsupported(
            "Printing needs WebView2 Runtime >= 1.0.1518.46 - update the runtime and try again.",
        )
    })?;
    // Safety: `core` is the live WebView2 of the hidden view, and this runs
    // on the thread that owns it.
    unsafe {
        print
            .ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM)
            .map_err(|e| ApiError::internal(format!("The print dialog failed: {e}")))?;
    }
    // `ShowPrintUI` reports only that the dialog was shown, not what the user
    // chose, so there is no cancel state to report cleanly.
    Ok(true)
}

/// macOS: print the hidden WKWebView.
///
/// The operation's view can crash with `EXC_BREAKPOINT` when it has no frame
/// yet - a hidden view never laid out - so it is pinned to the webview's own
/// bounds first. `runOperation` is modal and answers whether the user printed.
#[cfg(target_os = "macos")]
fn platform_print_macos(webview: &wry::WebView) -> Result<bool, ApiError> {
    use objc2_app_kit::NSPrintInfo;
    use wry::WebViewExtMacOS;

    let wk = webview.webview();
    // Safety: both objects are live views on the event loop thread.
    unsafe {
        let info = NSPrintInfo::sharedPrintInfo();
        let op = wk.printOperationWithPrintInfo(&info);
        if let Some(view) = op.view() {
            view.setFrame(wk.bounds());
        }
        Ok(op.runOperation())
    }
}

/// macOS: HTML -> vector PDF -> print.
///
/// Printing the `WKWebView` directly drops content that overflows to the
/// right, because WebKit prints the visible frame rather than the document.
/// Capturing a vector PDF first (via `createPDF`, i.e.
/// `createPDFWithConfiguration:completionHandler:` with a nil configuration)
/// normalises the full document independently of any frame, and the PDF is
/// what gets printed - invisibly to the application layer, which only ever
/// sees `{ printed }`.
///
/// The capture completes asynchronously on the main thread, so nothing here
/// blocks waiting for it: the completion block stages the PDF and navigates
/// the same hidden view to it, and its load event prints as usual.
#[cfg(target_os = "macos")]
fn begin_pdf_capture(rt: &Arc<Runtime>, state: &PrintState, job: u64) {
    use block2::StackBlock;
    use objc2_foundation::{NSData, NSError};
    use wry::WebViewExtMacOS;

    {
        let live = state.inner.live.borrow();
        let Some(entry) = live.get(&job) else {
            return;
        };
        if !matches!(entry.phase, Phase::Html) {
            return;
        }
    }
    if let Some(entry) = state.inner.live.borrow_mut().get_mut(&job) {
        entry.phase = Phase::Capturing;
    }

    let wk = {
        let live = state.inner.live.borrow();
        let Some(entry) = live.get(&job) else {
            return;
        };
        entry.webview.webview()
    };

    let rt = Arc::clone(rt);
    let state = state.clone();
    let block = StackBlock::new(move |data: *mut NSData, error: *mut NSError| {
        on_pdf_captured(&rt, &state, job, data, error);
    });
    // The capture retains the block; this heap copy outlives the stack frame.
    let block = block.copy();
    // Safety: `wk` is the live hidden view on the event loop thread, and the
    // block is retained by WebKit until it fires exactly once.
    unsafe {
        wk.createPDFWithConfiguration_completionHandler(None, &block);
    }
}

#[cfg(target_os = "macos")]
fn on_pdf_captured(
    rt: &Arc<Runtime>,
    state: &PrintState,
    job: u64,
    data: *mut objc2_foundation::NSData,
    error: *mut objc2_foundation::NSError,
) {
    // The pointers are valid only for this call; copy the bytes out at once.
    if data.is_null() || !error.is_null() {
        if let Some(entry) = state.take(job) {
            answer(
                rt,
                entry,
                Err(ApiError::internal(
                    "Could not render the page as PDF for printing",
                )),
            );
        }
        return;
    }
    // Safety: WebKit guarantees non-null data with a null error here.
    let bytes = unsafe { (&*data).to_vec() };

    let path = std::env::temp_dir().join(format!("vantail-print-{job}.pdf"));
    if let Err(e) = std::fs::write(&path, &bytes) {
        if let Some(entry) = state.take(job) {
            answer(
                rt,
                entry,
                Err(ApiError::io("Could not stage the print PDF", e)),
            );
        }
        return;
    }

    let mut live = state.inner.live.borrow_mut();
    let Some(entry) = live.get_mut(&job) else {
        let _ = std::fs::remove_file(&path);
        return;
    };
    entry.phase = Phase::Pdf;
    entry.pdf_temp = Some(path.clone());
    // Posting the navigation only; the PDF's own load event prints.
    if let Err(e) = entry.webview.load_url(&file_url(&path)) {
        drop(live);
        if let Some(entry) = state.take(job) {
            answer(
                rt,
                entry,
                Err(ApiError::internal(format!(
                    "Could not load the print PDF: {e}"
                ))),
            );
        }
    }
}

/// Linux: a `WebKitPrintOperation` on the hidden view.
///
/// `webkit_print_operation_run_dialog()` shows the GTK print dialog and starts
/// printing. There is no visible parent - the job owns a hidden window - so
/// the dialog is unparented, which GTK still presents modally.
#[cfg(target_os = "linux")]
fn platform_print_linux(webview: &wry::WebView) -> Result<bool, ApiError> {
    use webkit2gtk::prelude::PrintOperationExt;
    use webkit2gtk::{PrintOperation, PrintOperationResponse};
    use wry::WebViewExtUnix;

    let wk = webview.webview();
    let op = PrintOperation::new(&wk);
    let response = op.run_dialog(None::<&gtk::Window>);
    Ok(response == PrintOperationResponse::Print)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn params(html: Option<&str>, pdf_path: Option<&str>) -> DocumentParams {
        DocumentParams {
            html: html.map(str::to_string),
            pdf_path: pdf_path.map(str::to_string),
        }
    }

    fn code_of(result: Result<Source, ApiError>) -> String {
        result.unwrap_err().code
    }

    fn ok_of(result: Result<Source, ApiError>) -> Source {
        result.unwrap()
    }

    #[test]
    fn one_source_is_required() {
        assert_eq!(
            ok_of(split_source(&params(Some("<h1>hi</h1>"), None))),
            Source::Html("<h1>hi</h1>".to_string())
        );
        assert_eq!(
            ok_of(split_source(&params(None, Some("/tmp/a.pdf")))),
            Source::PdfPath("/tmp/a.pdf".to_string())
        );
    }

    #[test]
    fn neither_source_is_invalid_argument() {
        assert_eq!(
            code_of(split_source(&params(None, None))),
            code::INVALID_ARGUMENT
        );
        // Deserialization fills missing keys with `None`, so `{}` lands here.
        let empty: DocumentParams =
            serde_json::from_value(serde_json::json!({})).expect("empty object parses");
        assert_eq!(code_of(split_source(&empty)), code::INVALID_ARGUMENT);
    }

    #[test]
    fn both_sources_are_invalid_argument() {
        assert_eq!(
            code_of(split_source(&params(Some("<p>x</p>"), Some("/tmp/x.pdf")))),
            code::INVALID_ARGUMENT
        );
    }

    #[test]
    fn an_empty_string_names_no_content() {
        // `{ html: "" }` is neither: the empty half does not count, so the
        // call is missing a source rather than carrying two.
        assert_eq!(
            code_of(split_source(&params(Some(""), None))),
            code::INVALID_ARGUMENT
        );
        assert_eq!(
            code_of(split_source(&params(None, Some("")))),
            code::INVALID_ARGUMENT
        );
        assert_eq!(
            code_of(split_source(&params(Some(""), Some("")))),
            code::INVALID_ARGUMENT
        );
        // An empty half beside a real source is ignored, not a conflict.
        assert_eq!(
            ok_of(split_source(&params(Some(""), Some("/tmp/a.pdf")))),
            Source::PdfPath("/tmp/a.pdf".to_string())
        );
        assert_eq!(
            ok_of(split_source(&params(Some("<p>x</p>"), Some("")))),
            Source::Html("<p>x</p>".to_string())
        );
    }

    #[test]
    fn whitespace_is_content_not_absent() {
        // Only emptiness is filtered: a blank page is still an explicit
        // source (a separator page, say), and printing it is the caller's
        // choice rather than a validation failure.
        assert_eq!(
            ok_of(split_source(&params(Some("   "), None))),
            Source::Html("   ".to_string())
        );
    }

    #[test]
    fn a_wrong_type_fails_before_validation() {
        // `Request::params` rejects a non-string source with INVALID_PARAMS,
        // so `split_source` never sees it. Pinned here because the two codes
        // answer different questions: shape versus choice.
        let result: Result<DocumentParams, ApiError> =
            Request::params("print.document", serde_json::json!({ "html": 123 }));
        assert_eq!(result.unwrap_err().code, code::INVALID_PARAMS);
    }

    #[test]
    fn html_travels_as_a_padded_data_url() {
        let url = html_data_url("<h1>héllo & goodbye</h1>");
        assert!(url.starts_with("data:text/html;charset=utf-8,"), "{url}");
        // No raw markup survives: `<`, `>` and non-ASCII are all encoded.
        assert!(!url.contains('<'), "{url}");
        let encoded = url
            .strip_prefix("data:text/html;charset=utf-8,")
            .expect("prefix");
        let decoded = percent_encoding::percent_decode_str(encoded)
            .decode_utf8()
            .expect("utf-8");
        assert_eq!(decoded, "<h1>héllo & goodbye</h1>");
    }

    #[test]
    fn file_urls_keep_the_absolute_path_and_encode_reserved_chars() {
        let url = file_url(Path::new("/tmp/my invoice #1?.pdf"));
        assert!(url.starts_with("file:///tmp/"), "{url}");
        assert!(!url.contains(' '), "{url}");
        assert!(url.contains("%20"), "{url}");
        assert!(url.contains("%23"), "{url}");
        assert!(url.contains("%3F"), "{url}");
    }
}
