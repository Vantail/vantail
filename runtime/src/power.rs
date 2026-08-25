//! Sleep and wake.
//!
//! A long-running application usually has something that does not survive a
//! laptop lid closing - a socket, a lease, a clock it trusts. A page cannot be
//! told about that: there is no browser API for it, and the machine stops
//! executing JavaScript while it is asleep, so a timer cannot notice either.
//! All it can observe afterwards is that time jumped.
//!
//! Only macOS is wired up. The events simply do not fire elsewhere yet rather
//! than firing wrongly, and `power.supported()` says which it is, so an
//! application can fall back to its own reconnect timer where it has to.

#[cfg(target_os = "macos")]
use serde_json::json;

#[cfg(target_os = "macos")]
use crate::ipc::{Event, Outgoing};
use crate::state::Runtime;

/// Whether this build can report sleep and wake.
pub const fn supported() -> bool {
    cfg!(target_os = "macos")
}

/// Start listening. Called once, from the event loop thread.
#[cfg(target_os = "macos")]
pub fn watch(rt: &std::sync::Arc<Runtime>) {
    let rt = rt.clone();
    observe(move |event| {
        rt.send(None, Outgoing::Event(Event::new(event, json!({}))));
    });
}

/// Register for the two workspace notifications, calling `report` with the
/// event name for each.
///
/// Separate from [`watch`] so a test can register a counter instead of a
/// window, and check the observer really fires.
#[cfg(target_os = "macos")]
fn observe(report: impl Fn(&'static str) + Clone + 'static) {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{ns_string, NSNotification, NSString};

    // Both notifications carry nothing useful; the fact of them is the point.
    let notifications: [(&NSString, &'static str); 2] = [
        (
            ns_string!("NSWorkspaceWillSleepNotification"),
            "power.suspending",
        ),
        (
            ns_string!("NSWorkspaceDidWakeNotification"),
            "power.resumed",
        ),
    ];

    // Safety: the workspace notification centre is a process-wide singleton,
    // and the blocks live for the rest of the process along with the runtime
    // handle each one clones.
    unsafe {
        let centre = NSWorkspace::sharedWorkspace().notificationCenter();

        for (name, event) in notifications {
            let report = report.clone();
            let block = block2::RcBlock::new(move |_: core::ptr::NonNull<NSNotification>| {
                report(event);
            });

            // `None` for the queue: the block then runs on whichever thread
            // posted, and `send` is safe from any of them because it routes
            // through the event loop. Waiting for the main queue would mean
            // the notification is missed if the loop is mid-tick.
            let observer: Retained<ProtocolObject<dyn NSObjectProtocol>> =
                centre.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block);
            // Deliberately leaked: an observer that is dropped stops
            // observing, and this one should last as long as the process.
            std::mem::forget(observer);
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn watch(_rt: &std::sync::Arc<Runtime>) {}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    /// The observer really is registered, and really does fire.
    ///
    /// Posting the notification rather than sleeping the machine: the names
    /// and the centre are the same ones macOS uses, so what this leaves
    /// unproven is only that the system posts them - which is its documented
    /// behaviour, and not something a test could change.
    #[test]
    fn the_observer_hears_both_notifications() {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::ns_string;

        let heard: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));

        let recorder = heard.clone();
        observe(move |event| recorder.lock().expect("heard poisoned").push(event));

        // Safety: the same process-wide centre the observer registered with.
        unsafe {
            let centre = NSWorkspace::sharedWorkspace().notificationCenter();
            centre
                .postNotificationName_object(ns_string!("NSWorkspaceWillSleepNotification"), None);
            centre.postNotificationName_object(ns_string!("NSWorkspaceDidWakeNotification"), None);
        }

        let heard = heard.lock().expect("heard poisoned");
        assert_eq!(
            heard.as_slice(),
            ["power.suspending", "power.resumed"],
            "the observer did not fire for both"
        );
    }

    #[test]
    fn it_says_it_is_supported_here() {
        assert!(supported());
    }
}
