pub mod request;
pub mod response;
pub mod router;
pub mod worker;

pub use request::Request;
pub use response::{malformed, Event, Outgoing, Response};

/// Everything that reaches the event loop from somewhere else.
#[derive(Debug)]
pub enum UserEvent {
    /// A parsed call from JavaScript, tagged with the window it came from.
    Request { window: String, request: Request },
    /// A finished response or an event. `window: None` means every window.
    Outgoing {
        window: Option<String>,
        outgoing: Outgoing,
    },
    /// A menu item was chosen, anywhere in the application.
    Menu(String),
    /// Somebody started the application again while it was running.
    SecondInstance(crate::instance::Launch),
    /// A global shortcut was pressed, anywhere on the system.
    Shortcut(u32),
    /// The tray icon was clicked.
    Tray {
        event: &'static str,
        payload: serde_json::Value,
    },
}
