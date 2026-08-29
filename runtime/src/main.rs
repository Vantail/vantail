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
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder};

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
    let Some(config_path) = parse_args()? else {
        return Ok(()); // --help / --version already printed.
    };

    let loaded = LoadedConfig::load(&config_path)?;

    // Refused here rather than by the OS, so the error reaches whoever can
    // fix it.
    for protocol in &loaded.config.protocols {
        deeplink::is_valid_scheme(protocol)?;
    }

    // A previous version left behind by `updater.install` can only be removed
    // once nothing is running out of it - which is now.
    updater::clean_previous();

    let event_loop: EventLoop<UserEvent> = EventLoopBuilder::with_user_event().build();

    // Before anything is opened: a second launch should hand over what it was
    // asked to do and get out of the way, not build a whole second window
    // first.
    if loaded.config.wants_single_instance() {
        match instance::claim(&loaded.config.app.identifier, std::env::args().collect()) {
            Ok(instance::Claim::HandedOver) => return Ok(()),
            Ok(instance::Claim::Primary(listener)) => {
                instance::listen(listener, event_loop.create_proxy());
            }
            // Not being able to hold the lock is no reason to refuse to run.
            Err(error) => eprintln!("vantail: could not claim single instance: {error}"),
        }
    }

    let rt = Arc::new(Runtime::new(loaded, event_loop.create_proxy())?);

    // Windows and Linux deliver a link by starting the application with it on
    // the command line, which includes the very first launch.
    for url in deeplink::from_args(&rt.config.protocols, &std::env::args().collect::<Vec<_>>()) {
        let _ = rt.links.accept(url);
    }
    let pool = Pool::new(worker_count());
    let network_pool = Pool::new(worker_count());
    let mut windows = WindowManager::new();
    let mut chrome = Chrome::new();

    install_chrome_handlers(&event_loop);

    let main_config = rt.config.window.clone();
    let main_url = windows::resolve_url(&rt, None);
    windows.create(
        &event_loop,
        &rt,
        event_loop.create_proxy(),
        windows::MAIN,
        &main_config,
        &main_url,
    )?;

    if rt.is_dev() {
        eprintln!("vantail: {} -> {main_url}", rt.config.app.name);
    }

    let quit_when_empty = rt.config.quit_on_last_window_closed;

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            // Menus and the tray icon are created here rather than before the
            // loop starts: on macOS neither exists until the application has
            // actually launched.
            Event::NewEvents(StartCause::Init) => {
                // Sleep and wake, once the application is actually running.
                power::watch(&rt);

                // Every menu built from here on, including a tray menu set
                // much later, can label its Quit item.
                chrome::menu::remember_app_name(&rt.config.app.name);

                // On macOS a missing menu is not a cosmetic difference: without
                // one, Cmd-W, Cmd-Q, Cmd-C and friends do nothing at all. So an
                // application that sets none gets the standard one. `menu: []`
                // is how you ask for no menu on purpose.
                let default_menu = (cfg!(target_os = "macos") && rt.config.menu.is_none())
                    .then(|| chrome::menu::default_app_menu(&rt.config.app.name));
                let items = rt.config.menu.as_deref().or(default_menu.as_deref());

                if let Some(items) = items {
                    match chrome.set_app_menu(items) {
                        // The menu is installed either way; anything the
                        // platform refused was left out of it. Saying which
                        // item went missing is the difference between a
                        // puzzling gap in the menu bar and a one-line fix.
                        Ok(skipped) => {
                            for note in skipped {
                                eprintln!("vantail: menu item left out - {note}");
                            }
                        }
                        Err(error) => {
                            eprintln!("vantail: could not install the menu: {}", error.message);
                        }
                    }
                    for label in windows.labels() {
                        if let Some(entry) = windows.get(&label) {
                            chrome.attach(&entry.window);
                        }
                    }
                }
                if let Some(spec) = &rt.config.tray {
                    match chrome.set_tray(&rt, spec) {
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
            }

            // macOS hands a link to the running application rather than
            // starting a new one, so it arrives here instead of in argv.
            Event::Opened { urls } => {
                for url in urls {
                    deliver_link(&rt, &windows, url.to_string());
                }
            }

            Event::UserEvent(UserEvent::SecondInstance(launch)) => {
                for url in deeplink::from_args(&rt.config.protocols, &launch.args) {
                    deliver_link(&rt, &windows, url);
                }

                // Somebody tried to start the application again, so bring the
                // one that is already running to the front.
                if let Some(entry) = windows.get(windows::MAIN) {
                    entry.window.set_visible(true);
                    entry.window.set_focus();
                }

                windows.deliver(
                    None,
                    &Outgoing::Event(IpcEvent::new(
                        "app.secondInstance",
                        json!({ "args": launch.args, "cwd": launch.cwd }),
                    )),
                );
            }

            Event::LoopDestroyed => {
                rt.processes.kill_all();
                rt.discovery.shutdown();
                rt.devices.shutdown();
                rt.sockets.shutdown();
                rt.databases.shutdown();
            }

            Event::UserEvent(UserEvent::Menu(id)) => {
                // Quit is the runtime's own item, and takes the same route out
                // as `app.quit`: unwind the loop rather than let the platform
                // terminate the process from under it.
                if id == chrome::menu::QUIT_ID {
                    *control_flow = ControlFlow::Exit;
                    return;
                }

                windows.deliver(
                    None,
                    &Outgoing::Event(IpcEvent::new("menu.click", json!({ "id": id }))),
                );
            }

            Event::UserEvent(UserEvent::Shortcut(hotkey)) => {
                // The window server reports the combination, not what the
                // application called it, so the name is looked up here.
                if let Some((id, accelerator)) = chrome.shortcut_by_hotkey(hotkey) {
                    let payload = serde_json::json!({ "id": id, "accelerator": accelerator });
                    windows.deliver(
                        None,
                        &Outgoing::Event(IpcEvent::new("shortcut.pressed", payload)),
                    );
                }
            }

            Event::UserEvent(UserEvent::GrantHost { host, app, answer }) => {
                // The thread that asked is blocked until this replies, so the
                // dialog runs here and the answer goes straight back. Naming
                // the host is the whole point: a page that has been taken over
                // cannot reach somewhere new without a person reading where.
                let allowed = rfd::MessageDialog::new()
                    .set_level(rfd::MessageLevel::Warning)
                    .set_title(&app)
                    .set_description(format!(
                        "{app} wants to connect to {host}.\n\n                         Allow it for as long as {app} is running?"
                    ))
                    .set_buttons(rfd::MessageButtons::YesNo)
                    .show();
                let _ = answer.send(matches!(allowed, rfd::MessageDialogResult::Yes));
            }

            Event::UserEvent(UserEvent::Tray { event, payload }) => {
                let left = event == "tray.click"
                    && payload.get("button").and_then(|b| b.as_str()) == Some("left");
                if left {
                    activate_from_tray(&windows, &chrome);
                }
                windows.deliver(None, &Outgoing::Event(IpcEvent::new(event, payload)));
            }

            Event::WindowEvent { window_id, event, .. } => {
                // A window we have already dropped can still deliver a final
                // event; there is nothing left to tell anyone about it.
                let Some(label) = windows.by_id(window_id).map(|entry| entry.label.clone()) else {
                    return;
                };

                match event {
                    WindowEvent::CloseRequested | WindowEvent::Destroyed => {
                        // An application that lives in the tray needs its
                        // window to go away without its JavaScript going with
                        // it, so the close button is not always a close.
                        let action = api::window::close_action(
                            windows
                                .by_id(window_id)
                                .map(|entry| entry.close_behavior)
                                .unwrap_or_default(),
                        );

                        if action == api::window::CloseAction::Hide {
                            if let Some(entry) = windows.by_id(window_id) {
                                entry.window.set_visible(false);
                            }
                        }

                        match action.outcome() {
                            Some(outcome) => announce_close_request(&windows, &label, outcome),
                            None => {
                                if api::window::closed_by_user(&mut windows, &label, quit_when_empty)
                                {
                                    *control_flow = ControlFlow::Exit;
                                }
                            }
                        }
                    }
                    WindowEvent::Resized(size) => {
                        let Some(entry) = windows.by_id_mut(window_id) else {
                            return;
                        };
                        entry.size = size.to_logical::<f64>(entry.window.scale_factor());
                        let size = entry.size;
                        // A resize puts the traffic lights back where the
                        // platform wants them, so a window that moved them has
                        // to move them again - on every frame of the drag, or
                        // they visibly snap home while the user holds on.
                        entry.reapply_title_bar();
                        windows.deliver(
                            Some(&label),
                            &Outgoing::Event(IpcEvent::new(
                                "window.resized",
                                json!({ "width": size.width, "height": size.height, "label": label }),
                            )),
                        );
                    }
                    WindowEvent::Moved(position) => {
                        let Some(entry) = windows.by_id(window_id) else {
                            return;
                        };
                        let position = position.to_logical::<f64>(entry.window.scale_factor());
                        windows.deliver(
                            Some(&label),
                            &Outgoing::Event(IpcEvent::new(
                                "window.moved",
                                json!({ "x": position.x, "y": position.y, "label": label }),
                            )),
                        );
                    }
                    WindowEvent::Focused(focused) => {
                        if let Some(entry) = windows.by_id_mut(window_id) {
                            entry.focused = focused;
                        }
                        windows.deliver(
                            Some(&label),
                            &Outgoing::Event(IpcEvent::new(
                                "window.focus",
                                json!({ "focused": focused, "label": label }),
                            )),
                        );
                    }
                    _ => {}
                }
            }

            Event::UserEvent(UserEvent::Request { window, request }) => {
                let mut exit = false;
                let response = {
                    let mut ctx = MainCtx {
                        rt: &rt,
                        windows: &mut windows,
                        target,
                        source: &window,
                        chrome: &mut chrome,
                        pool: &pool,
                        network: &network_pool,
                        exit: &mut exit,
                    };
                    router::dispatch(&mut ctx, request)
                };

                if let Some(response) = response {
                    windows.deliver(Some(&window), &Outgoing::Response(response));
                }
                if exit {
                    *control_flow = ControlFlow::Exit;
                }
            }

            Event::UserEvent(UserEvent::Outgoing { window, outgoing }) => {
                windows.deliver(window.as_deref(), &outgoing);
            }

            _ => {}
        }
    });
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

/// Route menu and tray activations into the event loop.
///
/// Both libraries deliver their events through global handlers rather than
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
        // Enter, Move and Leave fire constantly and nobody has asked for
        // them; only the deliberate gestures are forwarded.
        let message = match event {
            tray_icon::TrayIconEvent::Click {
                position, button, ..
            } => Some((
                "tray.click",
                json!({
                    "button": format!("{button:?}").to_lowercase(),
                    "x": position.x,
                    "y": position.y,
                }),
            )),
            tray_icon::TrayIconEvent::DoubleClick {
                position, button, ..
            } => Some((
                "tray.doubleClick",
                json!({
                    "button": format!("{button:?}").to_lowercase(),
                    "x": position.x,
                    "y": position.y,
                }),
            )),
            _ => None,
        };

        if let Some((event, payload)) = message {
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

/// Returns `Ok(None)` when the process should exit quietly (`--help`).
fn parse_args() -> Result<Option<PathBuf>, String> {
    let mut args = std::env::args().skip(1);
    let mut config: Option<PathBuf> = None;

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

    Ok(Some(config))
}
