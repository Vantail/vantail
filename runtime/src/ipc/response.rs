use serde::Serialize;
use serde_json::Value;

use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone, Serialize)]
pub struct Response {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ApiError>,
}

impl Response {
    pub fn from_result(id: String, result: ApiResult) -> Self {
        match result {
            Ok(value) => Self {
                id,
                result: Some(value),
                error: None,
            },
            Err(error) => Self {
                id,
                result: None,
                error: Some(error),
            },
        }
    }
}

/// A push from the runtime that no one asked for: window resized, app about
/// to quit, and so on. The SDK turns these into listener callbacks.
#[derive(Debug, Clone, Serialize)]
pub struct Event {
    pub event: String,
    pub payload: Value,
}

impl Event {
    pub fn new(name: impl Into<String>, payload: Value) -> Self {
        Self {
            event: name.into(),
            payload,
        }
    }
}

/// Anything travelling runtime -> webview.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum Outgoing {
    Response(Response),
    Event(Event),
}

impl Outgoing {
    /// Render as a snippet for `WebView::evaluate_script`.
    ///
    /// The payload is embedded as a JS string literal and parsed with
    /// `JSON.parse`, which keeps arbitrary file contents from being able to
    /// break out into executable code.
    pub fn to_script(&self) -> String {
        let json = serde_json::to_string(self).unwrap_or_else(|e| {
            serde_json::json!({
                "id": "",
                "error": { "code": "INTERNAL", "message": format!("Response was not serialisable: {e}") }
            })
            .to_string()
        });
        format!(
            "window.__VANTAIL__ && window.__VANTAIL__._dispatch(JSON.parse({}))",
            js_string(&json)
        )
    }
}

/// A JS string literal. `serde_json` escapes everything JSON requires; the
/// two line separators below are legal in JSON but not inside a JS literal,
/// so they get escaped too.
fn js_string(value: &str) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "\"\"".into())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// Build a response for a message we could not even parse.
pub fn malformed(message: impl Into<String>) -> Outgoing {
    Outgoing::Response(Response {
        id: String::new(),
        result: None,
        error: Some(ApiError::invalid_params(message)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn script_for(result: Value) -> String {
        Outgoing::Response(Response {
            id: "1".into(),
            result: Some(result),
            error: None,
        })
        .to_script()
    }

    /// Pull the payload back out of the generated snippet the same way the
    /// browser would: read the string literal, then `JSON.parse` it.
    fn round_trip(result: Value) -> Value {
        let script = script_for(result);
        let open = script
            .find("JSON.parse(")
            .expect("script parses its payload")
            + "JSON.parse(".len();
        // The snippet ends with `))`: the inner JSON.parse and the outer call.
        let close = script.rfind("))").expect("call is closed");
        let literal = &script[open..close];

        let json: String = serde_json::from_str(literal).expect("literal is a JSON string");
        serde_json::from_str(&json).expect("payload is JSON")
    }

    #[test]
    fn file_contents_cannot_break_out_into_executable_code() {
        // The reason responses travel through a string literal and JSON.parse:
        // a file the app read must never be able to close the string and run.
        let hostile = "\" + alert('pwned') + \"";
        let parsed = round_trip(json!(hostile));

        assert_eq!(parsed["result"], json!(hostile));
        // The quote that would have ended the literal is escaped.
        assert!(script_for(json!(hostile)).contains("\\\""));
    }

    #[test]
    fn line_separators_legal_in_json_are_escaped_for_javascript() {
        // U+2028 and U+2029 are valid inside a JSON string but terminate a
        // JavaScript string literal, which would be a syntax error.
        let awkward = "before\u{2028}after\u{2029}end";
        let script = script_for(json!(awkward));

        assert!(!script.contains('\u{2028}'));
        assert!(!script.contains('\u{2029}'));
        assert!(script.contains("\\u2028"));
        assert_eq!(round_trip(json!(awkward))["result"], json!(awkward));
    }

    #[test]
    fn newlines_and_unicode_survive_the_trip() {
        let contents = "line one\nline two\ttabbed\n\u{1f600} caf\u{e9}";
        assert_eq!(round_trip(json!(contents))["result"], json!(contents));
    }

    #[test]
    fn a_response_carries_either_a_result_or_an_error_but_not_both() {
        let ok = Response::from_result("a".into(), Ok(json!(1)));
        assert!(ok.result.is_some() && ok.error.is_none());

        let failed = Response::from_result("b".into(), Err(ApiError::denied("no")));
        assert!(failed.result.is_none() && failed.error.is_some());
    }

    #[test]
    fn events_and_responses_are_told_apart_by_shape() {
        let event = Outgoing::Event(Event::new("window.resized", json!({ "width": 1 })));
        let serialised = serde_json::to_string(&event).expect("serialises");
        assert!(serialised.contains("\"event\":\"window.resized\""));
        assert!(!serialised.contains("\"id\""));
    }
}
