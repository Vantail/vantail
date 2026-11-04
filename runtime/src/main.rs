//! The Vantail runtime.
//!
//! One window, one webview, one IPC channel. It reads `vantail.json`, opens a
//! native window, points a webview at either the dev server or the
//! `vantail://` protocol, and answers calls from JavaScript.
//!
//! Application developers never build or run this directly - `@vantail/cli`
//! does, with a precompiled binary.

// A packaged Windows app should not flash a console window.
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
// Dead code is judged in the default build, where every capability is in.
// The config and permission layer is compiled whatever the features, so that
// one `vantail.json` reads the same everywhere - which leaves a build without
// `network` holding network scopes nothing reads. Gating each of those would
// make parsing depend on features; the stripped builds only have to prove
// they compile.
#![cfg_attr(
    not(all(
        feature = "database",
        feature = "devtools",
        feature = "hid",
        feature = "mdns",
        feature = "network",
        feature = "secrets",
        feature = "socks",
        feature = "updater",
        feature = "watch",
        feature = "websocket",
    )),
    allow(dead_code)
)]

mod api;
mod chrome;
mod config;
mod deeplink;
mod error;
mod instance;
mod ipc;
mod permissions;
mod power;
mod state;
mod updater;
mod webview;
mod windows;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use tao::dpi::{PhysicalPosition, PhysicalSize};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopWindowTarget};
use tao::window::WindowId;

use crate::chrome::Chrome;
use crate::config::LoadedConfig;
use crate::ipc::worker::Pool;
use crate::ipc::{router, Event as IpcEvent, Outgoing, UserEvent};
use crate::state::{MainCtx, Runtime};
use crate::windows::WindowManager;

const HELP: &str = "\
vantail-runtime - the native layer for a Vantail application

USAGE:
    vantail-runtime [OPTIONS] [CONFIG]

OPTIONS:
    -c, --config <PATH>    Path to vantail.json
                           (default: $VANTAIL_CONFIG, then next to the
                           executable, then ./vantail.json)
        --check            Read and validate the config, then exit without
                           opening anything. Exit status 1 and the reason on
                           stderr when the runtime would refuse to start.
    -V, --version          Print the runtime version
        --features         Print the capabilities this build was compiled with
    -h, --help             Print this message
";

/// What this build can actually do.
///
/// The features are compile-time, so two runtimes with the same version can
/// answer differently - a build without `secrets` reports `UNSUPPORTED` for
/// every call, which looks like a bug until you know. `vantail doctor` prints
/// this so nobody has to guess.
fn features() -> Vec<&'static str> {
    let mut names = Vec::new();
    for (enabled, name) in [
        (cfg!(feature = "devtools"), "devtools"),
        (cfg!(feature = "hid"), "hid"),
        (cfg!(feature = "mdns"), "mdns"),
        (cfg!(feature = "network"), "network"),
        (cfg!(feature = "secrets"), "secrets"),
        (cfg!(feature = "updater"), "updater"),
        (cfg!(feature = "watch"), "watch"),
    ] {
        if enabled {
            names.push(name);
        }
    }
    names
}

fn main() {
    if let Err(message) = run() {
        eprintln!("vantail: {message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let Some(Args {
        config: config_path,
        check,
    }) = parse_args()?
    else {
        return Ok(()); // --help / --version already printed.
    };

    let loaded = LoadedConfig::load(&config_path)?;

    // Refused here rather than by the OS, so the error reaches whoever can
    // fix it.
    for protocol in &loaded.config.protocols {
        deeplink::is_valid_scheme(protocol)?;
    }

    // Everything the config can be refused for happens before a window is
    // involved: the parse above, and compiling the permissions, which
    // `Runtime::new` does again for real. That is the whole of what a check
    // needs, and what lets the CLI's config tests ask this parser rather than
    // a copy of it.
    if check {
        let vars = permissions::Vars::resolve(&loaded.config.app.identifier, &loaded.dist_dir);
        permissions::Permissions::compile(&loaded.config.permissions, &vars)?;
        return Ok(());
    }

    // A previous version left behind by `updater.install` can only be removed
    // once nothing is running out of it - which is now.
    updater::clean_previous();

    // `mut` only so the Dock can be turned off below; nothing else touches it.
    let mut event_loop: EventLoop<UserEvent> = EventLoopBuilder::with_user_event().build();
    apply_dock_visibility(&mut event_loop, loaded.config.show_in_dock);

    // Before anything is opened: a second launch should hand over what it was
    // asked to do and get out of the way, not build a whole second window
    // first.
    if loaded.config.wants_single_instance() && handed_over(&loaded, &event_loop) {
        return Ok(());
    }

    let rt = Arc::new(Runtime::new(loaded, event_loop.create_proxy())?);
    let mut app = App::start(rt, &event_loop)?;

    event_loop.run(move |event, target, control_flow| {
        *control_flow = app.handle(event, target);
    });
}

/// Whether another copy of the application is already running and has been
/// handed this launch, in which case this one has nothing left to do.
fn handed_over(loaded: &LoadedConfig, event_loop: &EventLoop<UserEvent>) -> bool {
    match instance::claim(&loaded.config.app.identifier, std::env::args().collect()) {
        Ok(instance::Claim::HandedOver) => true,
        Ok(instance::Claim::Primary(listener)) => {
            instance::listen(listener, event_loop.create_proxy());
            false
        }
        // Not being able to hold the lock is no reason to refuse to run.
        Err(error) => {
            eprintln!("vantail: could not claim single instance: {error}");
            false
        }
    }
}

/// Everything the event loop holds on to between events.
struct App {
    rt: Arc<Runtime>,
    windows: WindowManager,
    chrome: Chrome,
    /// Blocking filesystem work.
    pool: Pool,
    /// Network requests, on their own queue so a slow host does not hold up
    /// a file read.
    network_pool: Pool,
    quit_when_empty: bool,
}

impl App {
    /// Take any link the application was launched with, and open the main
    /// window.
    fn start(rt: Arc<Runtime>, event_loop: &EventLoop<UserEvent>) -> Result<Self, String> {
        // Windows and Linux deliver a link by starting the application with it
        // on the command line, which includes the very first launch.
        for url in deeplink::from_args(&rt.config.protocols, &std::env::args().collect::<Vec<_>>())
        {
            let _ = rt.links.accept(url);
        }
        let pool = Pool::new(worker_count());
        let network_pool = Pool::new(worker_count());
        let mut windows = WindowManager::new();
        let chrome = Chrome::new();

        install_chrome_handlers(event_loop);

        let main_config = rt.config.window.clone();
        let main_url = windows::resolve_url(&rt, None);
        windows.create(event_loop, &rt, windows::MAIN, &main_config, &main_url)?;

        if rt.is_dev() {
            eprintln!("vantail: {} -> {main_url}", rt.config.app.name);
        }

        let quit_when_empty = rt.config.quit_on_last_window_closed;
        Ok(App {
            rt,
            windows,
            chrome,
            pool,
            network_pool,
            quit_when_empty,
        })
    }

    /// Handle one event, and say whether the loop carries on.
    ///
    /// Only three things end it: the Quit menu item, the last window closing,
    /// and a call to `app.quit`. Their handlers say so by what they return.
    fn handle(
        &mut self,
        event: Event<'_, UserEvent>,
        target: &EventLoopWindowTarget<UserEvent>,
    ) -> ControlFlow {
        match event {
            // Menus and the tray icon are created here rather than before the
            // loop starts: on macOS neither exists until the application has
            // actually launched.
            Event::NewEvents(StartCause::Init) => self.launched(),

            // macOS hands a link to the running application rather than
            // starting a new one, so it arrives here instead of in argv.
            Event::Opened { urls } => {
                for url in urls {
                    deliver_link(&self.rt, &self.windows, url.to_string());
                }
            }

            Event::UserEvent(UserEvent::SecondInstance(launch)) => self.second_instance(launch),
            Event::LoopDestroyed => self.shut_down(),
            Event::UserEvent(UserEvent::Menu(id)) => return self.menu_clicked(id),
            Event::UserEvent(UserEvent::Shortcut(hotkey)) => self.shortcut_pressed(hotkey),

            // The thread that asked is blocked until this replies, so the
            // dialog runs here and the answer goes straight back.
            Event::UserEvent(UserEvent::GrantHost { host, app, answer }) => {
                let _ = answer.send(ask_to_grant_host(&host, &app));
            }

            // A print job that is still rendering after its deadline fails
            // rather than hanging the caller's promise. A job that already
            // reached its dialog was taken before the dialog opened, so this
            // only ever catches renders.
            Event::UserEvent(UserEvent::PrintTimeout { job }) => {
                crate::api::print::timed_out(&self.rt, &self.windows.print, job);
            }

            #[cfg(target_os = "windows")]
            Event::UserEvent(UserEvent::PrintClosed { job }) => {
                crate::api::print::closed(&self.rt, &self.windows.print, job);
            }

            Event::UserEvent(UserEvent::Tray { event, payload }) => self.tray_event(event, payload),
            Event::WindowEvent {
                window_id, event, ..
            } => return self.window_event(window_id, event),
            Event::UserEvent(UserEvent::Request { window, request }) => {
                return self.request(target, &window, request);
            }
            Event::UserEvent(UserEvent::Outgoing { window, outgoing }) => {
                self.windows.deliver(window.as_deref(), &outgoing);
            }
            _ => {}
        }
        ControlFlow::Wait
    }

    /// The application has launched, so what needs it to exist can be set up.
    fn launched(&mut self) {
        // Sleep and wake, once the application is actually running.
        power::watch(&self.rt);

        // Every menu built from here on, including a tray menu set much later,
        // can label its Quit item.
        chrome::menu::remember_app_name(&self.rt.config.app.name);

        self.install_menu();
        self.install_tray();
    }

    fn install_menu(&mut self) {
        // On macOS a missing menu is not a cosmetic difference: without one,
        // Cmd-W, Cmd-Q, Cmd-C and friends do nothing at all. So an application
        // that sets none gets the standard one. `menu: []` is how you ask for
        // no menu on purpose.
        let default_menu = (cfg!(target_os = "macos") && self.rt.config.menu.is_none())
            .then(|| chrome::menu::default_app_menu(&self.rt.config.app.name));
        let Some(items) = self.rt.config.menu.as_deref().or(default_menu.as_deref()) else {
            return;
        };

        match self.chrome.set_app_menu(items) {
            // The menu is installed either way; anything the platform refused
            // was left out of it. Saying which item went missing is the
            // difference between a puzzling gap in the menu bar and a one-line
            // fix.
            Ok(skipped) => {
                for note in skipped {
                    eprintln!("vantail: menu item left out - {note}");
                }
            }
            Err(error) => {
                eprintln!("vantail: could not install the menu: {}", error.message);
            }
        }
        for label in self.windows.labels() {
            if let Some(entry) = self.windows.get(&label) {
                self.chrome.attach(&entry.window);
            }
        }
    }

    fn install_tray(&mut self) {
        let Some(spec) = &self.rt.config.tray else {
            return;
        };
        match self.chrome.set_tray(&self.rt, spec) {
            Ok(skipped) => {
                for note in skipped {
                    eprintln!("vantail: tray menu item left out - {note}");
                }
            }
            Err(error) => {
                eprintln!("vantail: could not create the tray icon: {}", error.message);
            }
        }
    }

    /// Somebody tried to start the application again.
    fn second_instance(&self, launch: instance::Launch) {
        for url in deeplink::from_args(&self.rt.config.protocols, &launch.args) {
            deliver_link(&self.rt, &self.windows, url);
        }

        // So bring the one that is already running to the front.
        if let Some(entry) = self.windows.get(windows::MAIN) {
            entry.window.set_visible(true);
            entry.window.set_focus();
        }

        self.windows.deliver(
            None,
            &Outgoing::Event(IpcEvent::new(
                "app.secondInstance",
                json!({ "args": launch.args, "cwd": launch.cwd }),
            )),
        );
    }

    fn shut_down(&self) {
        self.rt.processes.kill_all();
        self.rt.discovery.shutdown();
        self.rt.devices.shutdown();
        self.rt.sockets.shutdown();
        self.rt.databases.shutdown();
    }

    fn menu_clicked(&self, id: String) -> ControlFlow {
        // Quit is the runtime's own item, and takes the same route out as
        // `app.quit`: unwind the loop rather than let the platform terminate
        // the process from under it.
        if id == chrome::menu::QUIT_ID {
            return ControlFlow::Exit;
        }

        self.windows.deliver(
            None,
            &Outgoing::Event(IpcEvent::new("menu.click", json!({ "id": id }))),
        );
        ControlFlow::Wait
    }

    fn shortcut_pressed(&self, hotkey: u32) {
        // The window server reports the combination, not what the application
        // called it, so the name is looked up here.
        let Some((id, accelerator)) = self.chrome.shortcut_by_hotkey(hotkey) else {
            return;
        };
        let payload = json!({ "id": id, "accelerator": accelerator });
        self.windows.deliver(
            None,
            &Outgoing::Event(IpcEvent::new("shortcut.pressed", payload)),
        );
    }

    fn tray_event(&self, event: &'static str, payload: serde_json::Value) {
        let left =
            event == "tray.click" && payload.get("button").and_then(|b| b.as_str()) == Some("left");
        if left {
            activate_from_tray(&self.windows, &self.chrome);
        }
        self.windows
            .deliver(None, &Outgoing::Event(IpcEvent::new(event, payload)));
    }

    fn window_event(&mut self, window_id: WindowId, event: WindowEvent<'_>) -> ControlFlow {
        // A window we have already dropped can still deliver a final event;
        // there is nothing left to tell anyone about it.
        let Some(label) = self
            .windows
            .by_id(window_id)
            .map(|entry| entry.label.clone())
        else {
            // A print window is never listed; closing it ends its job.
            #[cfg(target_os = "windows")]
            if matches!(event, WindowEvent::CloseRequested) {
                crate::api::print::close_requested(&self.rt, &self.windows.print, window_id);
            }
            return ControlFlow::Wait;
        };

        match event {
            WindowEvent::CloseRequested | WindowEvent::Destroyed => {
                return self.close_requested(window_id, &label);
            }
            WindowEvent::Resized(size) => self.resized(window_id, &label, size),
            WindowEvent::Moved(position) => self.moved(window_id, &label, position),
            WindowEvent::Focused(focused) => self.focused(window_id, &label, focused),
            _ => {}
        }
        ControlFlow::Wait
    }

    fn close_requested(&mut self, window_id: WindowId, label: &str) -> ControlFlow {
        // An application that lives in the tray needs its window to go away
        // without its JavaScript going with it, so the close button is not
        // always a close.
        let behavior = self
            .windows
            .by_id(window_id)
            .map(|entry| entry.close_behavior)
            .unwrap_or_default();
        let action = api::window::close_action(behavior);

        if action == api::window::CloseAction::Hide {
            if let Some(entry) = self.windows.by_id(window_id) {
                entry.window.set_visible(false);
            }
        }

        let Some(outcome) = action.outcome() else {
            if api::window::closed_by_user(&mut self.windows, label, self.quit_when_empty) {
                return ControlFlow::Exit;
            }
            return ControlFlow::Wait;
        };
        announce_close_request(&self.windows, label, outcome);
        ControlFlow::Wait
    }

    fn resized(&mut self, window_id: WindowId, label: &str, size: PhysicalSize<u32>) {
        let Some(entry) = self.windows.by_id_mut(window_id) else {
            return;
        };
        entry.size = size.to_logical::<f64>(entry.window.scale_factor());
        let size = entry.size;
        // A resize puts the traffic lights back where the platform wants them,
        // so a window that moved them has to move them again - on every frame
        // of the drag, or they visibly snap home while the user holds on.
        entry.reapply_title_bar();
        // A corner shape is a path, not a property: it has to be rebuilt at
        // the new size or it keeps the old one.
        entry.reshape_corners();
        self.windows.deliver(
            Some(label),
            &Outgoing::Event(IpcEvent::new(
                "window.resized",
                json!({ "width": size.width, "height": size.height, "label": label }),
            )),
        );
    }

    fn moved(&self, window_id: WindowId, label: &str, position: PhysicalPosition<i32>) {
        let Some(entry) = self.windows.by_id(window_id) else {
            return;
        };
        let position = position.to_logical::<f64>(entry.window.scale_factor());
        self.windows.deliver(
            Some(label),
            &Outgoing::Event(IpcEvent::new(
                "window.moved",
                json!({ "x": position.x, "y": position.y, "label": label }),
            )),
        );
    }

    fn focused(&mut self, window_id: WindowId, label: &str, focused: bool) {
        if let Some(entry) = self.windows.by_id_mut(window_id) {
            entry.focused = focused;
        }
        self.windows.deliver(
            Some(label),
            &Outgoing::Event(IpcEvent::new(
                "window.focus",
                json!({ "focused": focused, "label": label }),
            )),
        );
    }

    /// A call from JavaScript, answered on the window that made it.
    fn request(
        &mut self,
        target: &EventLoopWindowTarget<UserEvent>,
        window: &str,
        request: ipc::Request,
    ) -> ControlFlow {
        let mut exit = false;
        let response = {
            let mut ctx = MainCtx {
                rt: &self.rt,
                windows: &mut self.windows,
                target,
                source: window,
                chrome: &mut self.chrome,
                pool: &self.pool,
                network: &self.network_pool,
                exit: &mut exit,
            };
            router::dispatch(&mut ctx, request)
        };

        if let Some(response) = response {
            self.windows
                .deliver(Some(window), &Outgoing::Response(response));
        }
        if exit {
            return ControlFlow::Exit;
        }
        ControlFlow::Wait
    }
}

/// Ask whether a page may reach a host the config did not name.
///
/// Naming the host is the whole point: a page that has been taken over cannot
/// reach somewhere new without a person reading where.
fn ask_to_grant_host(host: &str, app: &str) -> bool {
    let allowed = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title(app)
        .set_description(format!(
            "{app} wants to connect to {host}.\n\nAllow it for as long as {app} is running?"
        ))
        .set_buttons(rfd::MessageButtons::YesNo)
        .show();
    matches!(allowed, rfd::MessageDialogResult::Yes)
}

/// Hand a deep link to the application, or hold it until someone is listening.
///
/// An application launched *by* a link gets it before its window exists, so a
/// link that arrives early waits rather than being delivered into a page that
/// has not loaded.
fn deliver_link(rt: &Runtime, windows: &WindowManager, url: String) {
    if let crate::deeplink::Delivery::Now(url) = rt.links.accept(url) {
        windows.deliver(
            None,
            &Outgoing::Event(IpcEvent::new("deeplink.open", json!({ "url": url }))),
        );
    }
}

/// What a left click on the tray icon does.
///
/// A tray icon exists so the window can come back, so that is the first thing
/// tried. Only when the window is already in front - where bringing it forward
/// would do nothing visible - does the menu open instead.
fn activate_from_tray(windows: &WindowManager, chrome: &Chrome) {
    use crate::chrome::{tray_activation, TrayActivation, WindowState};

    let target = windows.get(chrome.tray_window());
    let state = target.map(|entry| WindowState {
        visible: entry.window.is_visible(),
        focused: entry.focused,
    });

    match tray_activation(chrome.tray_left_click(), state) {
        TrayActivation::ShowAndFocus => {
            if let Some(entry) = target {
                entry.window.set_visible(true);
                entry.window.set_focus();
            }
        }
        TrayActivation::Focus => {
            if let Some(entry) = target {
                entry.window.set_focus();
            }
        }
        TrayActivation::ShowMenu => {
            let _ = chrome.show_tray_menu();
        }
        TrayActivation::Nothing => {}
    }
}

/// Tell a window its close button was pressed, and what the runtime did
/// about it.
fn announce_close_request(windows: &WindowManager, label: &str, outcome: &str) {
    windows.deliver(
        Some(label),
        &Outgoing::Event(IpcEvent::new(
            "window.closeRequested",
            json!({ "label": label, "outcome": outcome }),
        )),
    );
}

/// Whether the application appears in the Dock.
///
/// macOS reads the activation policy when the event loop starts running and
/// ignores it afterwards, so this is the only moment it can be said. Nothing
/// to do anywhere else - `showInDock` is documented as macOS only - but the
/// setting is still read on every platform, because a field only ever read
/// inside a `cfg` is dead code on the platforms that compile it out.
fn apply_dock_visibility(event_loop: &mut EventLoop<UserEvent>, show_in_dock: bool) {
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::EventLoopExtMacOS;
        if !show_in_dock {
            event_loop.set_dock_visibility(false);
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (event_loop, show_in_dock);
}

/// Route menu, shortcut and tray activations into the event loop.
///
/// These libraries deliver their events through global handlers rather than
/// through the window system, so this is where they rejoin everything else.
fn install_chrome_handlers(event_loop: &EventLoop<UserEvent>) {
    let proxy = event_loop.create_proxy();
    muda::MenuEvent::set_event_handler(Some(move |event: muda::MenuEvent| {
        let _ = proxy.send_event(UserEvent::Menu(event.id.0));
    }));

    let proxy = event_loop.create_proxy();
    global_hotkey::GlobalHotKeyEvent::set_event_handler(Some(
        move |event: global_hotkey::GlobalHotKeyEvent| {
            // Both press and release arrive; a shortcut fires once, on press.
            if event.state() == global_hotkey::HotKeyState::Pressed {
                let _ = proxy.send_event(UserEvent::Shortcut(event.id()));
            }
        },
    ));

    let proxy = event_loop.create_proxy();
    tray_icon::TrayIconEvent::set_event_handler(Some(move |event: tray_icon::TrayIconEvent| {
        // Which events are worth forwarding, and which of the pair a single
        // click produces, is decided in `chrome::tray_message`.
        if let Some((event, payload)) = crate::chrome::tray_message(&event) {
            let _ = proxy.send_event(UserEvent::Tray { event, payload });
        }
    }));
}

/// Enough workers to keep a handful of file operations in flight without
/// turning into a thread farm on a small machine.
fn worker_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().clamp(2, 8))
        .unwrap_or(4)
}

struct Args {
    config: PathBuf,
    /// `--check`: validate the config and exit.
    check: bool,
}

/// Returns `Ok(None)` when the process should exit quietly (`--help`).
fn parse_args() -> Result<Option<Args>, String> {
    let mut args = std::env::args().skip(1);
    let mut config: Option<PathBuf> = None;
    let mut check = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                println!("{HELP}");
                return Ok(None);
            }
            "-V" | "--version" => {
                println!("{}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "--features" => {
                println!("{}", features().join(" "));
                return Ok(None);
            }
            "--check" => check = true,
            "-c" | "--config" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--config needs a path".to_string())?;
                config = Some(PathBuf::from(value));
            }
            other if other.starts_with('-') => {
                return Err(format!("Unknown option `{other}`. Try --help."));
            }
            // A deep link arrives as a bare argument on Windows and Linux,
            // and is emphatically not the config file.
            positional if positional.contains("://") => {}
            positional => config = Some(PathBuf::from(positional)),
        }
    }

    let config = config
        .or_else(|| std::env::var_os("VANTAIL_CONFIG").map(PathBuf::from))
        .or_else(LoadedConfig::discover)
        .ok_or_else(|| {
            "No vantail.json found. Pass --config <path>, or run this through `vantail dev`."
                .to_string()
        })?;

    Ok(Some(Args { config, check }))
}
