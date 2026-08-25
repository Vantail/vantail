//! Shared runtime state.
//!
//! `Runtime` is everything a native API might need that is safe to touch from
//! any thread. `MainCtx` adds the things that are only valid on the event
//! loop thread - the window and the webview.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tao::event_loop::{EventLoopProxy, EventLoopWindowTarget};

use crate::api::process::Registry;
use crate::chrome::Chrome;
use crate::config::{Config, LoadedConfig};
use crate::ipc::{Outgoing, UserEvent};
use crate::permissions::{Permissions, Vars};
use crate::windows::WindowManager;

pub struct Runtime {
    pub config: Config,
    /// Directory holding the built web assets. Also `$RESOURCE` in scopes.
    pub resource_dir: PathBuf,
    pub permissions: Permissions,
    /// Child processes this application has started.
    pub processes: Registry,
    /// Deep links that have arrived, and whether anyone is listening.
    pub links: crate::deeplink::Links,
    /// Open HID devices.
    pub devices: crate::api::hid::Devices,
    /// mDNS discovery, started only if the application asks for it.
    pub discovery: crate::api::mdns::Discovery,
    /// An update that has been downloaded and verified, if any.
    pub updates: crate::updater::State,
    /// Live filesystem watches, keyed by the id handed to the application.
    pub watch: crate::api::watch::State,
    proxy: Mutex<EventLoopProxy<UserEvent>>,
}

impl Runtime {
    pub fn new(loaded: LoadedConfig, proxy: EventLoopProxy<UserEvent>) -> Result<Self, String> {
        let vars = Vars::resolve(&loaded.config.app.identifier, &loaded.dist_dir);
        let permissions = Permissions::compile(&loaded.config.permissions, &vars)?;

        Ok(Self {
            config: loaded.config,
            resource_dir: loaded.dist_dir,
            permissions,
            processes: Registry::default(),
            links: crate::deeplink::Links::default(),
            devices: crate::api::hid::Devices::default(),
            discovery: crate::api::mdns::Discovery::default(),
            updates: crate::updater::State::default(),
            watch: crate::api::watch::State::default(),
            proxy: Mutex::new(proxy),
        })
    }

    pub fn proxy(&self) -> EventLoopProxy<UserEvent> {
        self.proxy
            .lock()
            .expect("event loop proxy poisoned")
            .clone()
    }

    pub fn is_dev(&self) -> bool {
        self.config.dev.is_some()
    }

    /// Push a response or event to one window, or to all of them when
    /// `window` is `None`.
    ///
    /// Safe from any thread: the message is routed through the event loop,
    /// which is the only place that may touch a webview.
    pub fn send(&self, window: Option<String>, outgoing: Outgoing) {
        let proxy = self.proxy.lock().expect("event loop proxy poisoned");
        // A send failure means the event loop is gone, i.e. we are shutting
        // down. Nothing useful left to do with the message.
        let _ = proxy.send_event(UserEvent::Outgoing { window, outgoing });
    }
}

/// Borrowed handles that only exist on the event loop thread.
pub struct MainCtx<'a> {
    pub rt: &'a Arc<Runtime>,
    /// Every open window. Handlers address one by label.
    pub windows: &'a mut WindowManager,
    /// Needed to open new windows, which can only happen on this thread.
    pub target: &'a EventLoopWindowTarget<UserEvent>,
    /// The label of the window that made this call. Window methods act on it
    /// unless the call names a different one.
    pub source: &'a str,
    /// The menu bar and tray icon, which live outside any window.
    pub chrome: &'a mut Chrome,
    /// Blocking filesystem work is queued here instead of on the event loop.
    pub pool: &'a crate::ipc::worker::Pool,
    /// Network requests get their own queue: an unreachable device takes the
    /// full timeout to say so, and should not delay a file read while it does.
    pub network: &'a crate::ipc::worker::Pool,
    /// Set by `app.quit` to unwind the event loop.
    pub exit: &'a mut bool,
}

impl MainCtx<'_> {
    /// A fresh proxy for handing to a newly created webview.
    pub fn proxy(&self) -> EventLoopProxy<UserEvent> {
        self.rt.proxy()
    }
}
