//! `myapp://` links.
//!
//! A desktop application that signs in with OAuth needs somewhere for the
//! browser to send the user back to, and a custom scheme is how that is done
//! everywhere. It arrives differently on each platform - macOS hands the URL
//! to the running application, while Windows and Linux launch a *new* process
//! with the URL in its arguments - so this is also the reason single instance
//! exists.
//!
//! Everything that arrives here is untrusted. A link can be opened by any web
//! page or any program on the machine, so the runtime delivers only schemes
//! the application registered, and the application still has to treat the
//! contents as input from a stranger.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Schemes an application may not claim.
///
/// Registering `http` would let an application intercept the web, and `file`
/// or `javascript` are worse. The OS may refuse anyway; refusing here means
/// the error arrives at the person who can fix it.
const RESERVED: &[&str] = &[
    "http",
    "https",
    "file",
    "ftp",
    "mailto",
    "data",
    "javascript",
    "about",
    "blob",
    "ws",
    "wss",
    "chrome",
    "vantail",
];

/// Whether a string is a scheme an application may register.
///
/// The rule is RFC 3986's, minus the reserved list: a letter, then letters,
/// digits, `+`, `-` and `.`.
pub fn is_valid_scheme(scheme: &str) -> Result<(), String> {
    if scheme.is_empty() {
        return Err("A protocol cannot be empty".to_string());
    }
    if scheme.len() > 32 {
        return Err(format!("`{scheme}` is too long for a protocol"));
    }

    let mut characters = scheme.chars();
    let first = characters.next().unwrap_or_default();
    if !first.is_ascii_lowercase() {
        return Err(format!(
            "`{scheme}` must start with a lowercase letter - protocols are matched case-insensitively"
        ));
    }
    if !characters
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '-' | '.'))
    {
        return Err(format!(
            "`{scheme}` may only contain lowercase letters, digits, `+`, `-` and `.`"
        ));
    }
    if RESERVED.contains(&scheme) {
        return Err(format!("`{scheme}` is reserved and cannot be registered"));
    }

    Ok(())
}

/// Pick the deep links out of a command line.
///
/// Windows and Linux deliver a link by starting the application with the URL
/// as an argument, mixed in with whatever else was on the command line - so
/// only arguments that begin with a registered scheme are taken.
pub fn from_args(protocols: &[String], args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|argument| matches(protocols, argument))
        .cloned()
        .collect()
}

/// Whether a URL uses one of the application's own schemes.
pub fn matches(protocols: &[String], url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else {
        return false;
    };
    // A bare `myapp:` with nothing after it is not a link to anything.
    if rest.is_empty() {
        return false;
    }
    protocols
        .iter()
        .any(|protocol| protocol.eq_ignore_ascii_case(scheme))
}

/// Links that have arrived, and whether anyone is listening yet.
///
/// An application launched *by* a link gets it before its window exists, so
/// the URL is held until JavaScript asks for it rather than delivered into a
/// page that has not loaded.
#[derive(Default)]
pub struct Links {
    pending: Mutex<Vec<String>>,
    streaming: AtomicBool,
}

impl Links {
    /// Record a link, or report that it should be delivered live.
    pub fn accept(&self, url: String) -> Delivery {
        if self.streaming.load(Ordering::Relaxed) {
            return Delivery::Now(url);
        }
        self.pending.lock().expect("deep links poisoned").push(url);
        Delivery::Held
    }

    /// Called when JavaScript subscribes: hand over everything held so far and
    /// deliver the rest as it arrives.
    pub fn drain(&self) -> Vec<String> {
        self.streaming.store(true, Ordering::Relaxed);
        std::mem::take(&mut *self.pending.lock().expect("deep links poisoned"))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Send it to the window now.
    Now(String),
    /// Nobody is listening yet; it is waiting.
    Held,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn protocols() -> Vec<String> {
        vec!["myapp".to_string(), "com.example.app".to_string()]
    }

    #[test]
    fn a_scheme_has_to_look_like_a_scheme() {
        assert!(is_valid_scheme("myapp").is_ok());
        assert!(is_valid_scheme("com.example.app").is_ok());
        assert!(is_valid_scheme("app-2").is_ok());

        assert!(is_valid_scheme("").is_err());
        assert!(is_valid_scheme("2fast").is_err());
        assert!(is_valid_scheme("My App").is_err());
        // Uppercase is refused rather than folded, so what is written in the
        // config is what gets registered with the OS.
        assert!(is_valid_scheme("MyApp").is_err());
    }

    #[test]
    fn the_schemes_that_would_hijack_the_web_are_refused() {
        for scheme in ["http", "https", "file", "javascript", "mailto"] {
            assert!(
                is_valid_scheme(scheme).is_err(),
                "{scheme} should be reserved"
            );
        }
        // Ours too: an application must not impersonate the runtime's own
        // asset protocol.
        assert!(is_valid_scheme("vantail").is_err());
    }

    #[test]
    fn only_registered_schemes_count_as_links() {
        assert!(matches(&protocols(), "myapp://callback?code=1"));
        // Schemes are case-insensitive on the wire even though the config
        // must be lowercase.
        assert!(matches(&protocols(), "MyApp://callback"));
        assert!(!matches(&protocols(), "https://example.com"));
        assert!(!matches(&protocols(), "otherapp://x"));
        assert!(!matches(&protocols(), "not a url"));
        assert!(!matches(&protocols(), "myapp:"));
    }

    #[test]
    fn links_are_picked_out_of_a_whole_command_line() {
        let args = vec![
            "--config".to_string(),
            "/path/vantail.json".to_string(),
            "myapp://callback?code=abc".to_string(),
            "https://example.com".to_string(),
        ];
        assert_eq!(
            from_args(&protocols(), &args),
            vec!["myapp://callback?code=abc".to_string()]
        );
    }

    #[test]
    fn a_link_that_arrives_before_anyone_is_listening_is_kept() {
        // The cold-start case: the application was launched *by* the link, so
        // it arrives long before the page that wants it.
        let links = Links::default();
        assert_eq!(links.accept("myapp://one".into()), Delivery::Held);
        assert_eq!(links.accept("myapp://two".into()), Delivery::Held);

        assert_eq!(links.drain(), vec!["myapp://one", "myapp://two"]);
        // Drained once, and not again.
        assert!(links.drain().is_empty());

        // From then on they go straight through.
        assert_eq!(
            links.accept("myapp://three".into()),
            Delivery::Now("myapp://three".into())
        );
    }
}
