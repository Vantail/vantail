//! `secrets.*` - the operating system's credential store.
//!
//! An application that holds an OAuth refresh token has to put it somewhere.
//! `localStorage` is a plaintext file in the application's data directory,
//! readable by anything running as the user - including the next thing that
//! talks them into running a script. Every desktop platform already has a
//! better answer, and none of them has a browser API.
//!
//! Entries are filed under the application's identifier, so two Vantail
//! applications on the same machine cannot read each other's.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{code, ApiError, ApiResult};
use crate::ipc::Request;
use crate::state::Runtime;

/// Long enough for a JWT with room to spare, short enough that a bug cannot
/// try to push a file into the keychain.
const MAX_SECRET_BYTES: usize = 64 * 1024;
const MAX_KEY_BYTES: usize = 256;

#[derive(Deserialize)]
struct KeyParams {
    key: String,
}

#[derive(Deserialize)]
struct SetParams {
    key: String,
    value: String,
}

pub fn dispatch(rt: &Runtime, method: &str, params: Value) -> ApiResult {
    rt.permissions.require(rt.permissions.secrets, method)?;

    match method {
        "secrets.set" => {
            let SetParams { key, value } = Request::params(method, params)?;
            check_key(&key)?;
            if value.len() > MAX_SECRET_BYTES {
                return Err(ApiError::invalid_params(format!(
                    "A secret may be at most {MAX_SECRET_BYTES} bytes; this one is {}",
                    value.len()
                )));
            }
            entry(rt, &key)?
                .set_password(&value)
                .map(|()| Value::Null)
                .map_err(|e| failed("store", &key, e))
        }

        "secrets.get" => {
            let KeyParams { key } = Request::params(method, params)?;
            check_key(&key)?;
            match entry(rt, &key)?.get_password() {
                Ok(value) => Ok(json!(value)),
                // A missing secret is an answer, not a failure - an app asking
                // "am I signed in?" should not have to catch an exception.
                Err(keyring::Error::NoEntry) => Ok(Value::Null),
                Err(error) => Err(failed("read", &key, error)),
            }
        }

        "secrets.has" => {
            let KeyParams { key } = Request::params(method, params)?;
            check_key(&key)?;
            match entry(rt, &key)?.get_password() {
                Ok(_) => Ok(json!(true)),
                Err(keyring::Error::NoEntry) => Ok(json!(false)),
                Err(error) => Err(failed("read", &key, error)),
            }
        }

        "secrets.delete" => {
            let KeyParams { key } = Request::params(method, params)?;
            check_key(&key)?;
            match entry(rt, &key)?.delete_credential() {
                Ok(()) => Ok(json!(true)),
                Err(keyring::Error::NoEntry) => Ok(json!(false)),
                Err(error) => Err(failed("delete", &key, error)),
            }
        }

        _ => Err(ApiError::unknown_method(method)),
    }
}

fn entry(rt: &Runtime, key: &str) -> Result<keyring::Entry, ApiError> {
    keyring::Entry::new(&rt.config.app.identifier, key).map_err(|error| {
        ApiError::unsupported(format!(
            "This system has no usable credential store: {error}"
        ))
    })
}

/// Keys end up as identifiers inside somebody else's database, so keep them
/// to something every platform can store and a human can find again.
fn check_key(key: &str) -> Result<(), ApiError> {
    if key.is_empty() {
        return Err(ApiError::invalid_params("A secret key cannot be empty"));
    }
    if key.len() > MAX_KEY_BYTES {
        return Err(ApiError::invalid_params(format!(
            "A secret key may be at most {MAX_KEY_BYTES} bytes"
        )));
    }
    if key.chars().any(|c| c.is_control()) {
        return Err(ApiError::invalid_params(
            "A secret key cannot contain control characters",
        ));
    }
    Ok(())
}

fn failed(action: &str, key: &str, error: keyring::Error) -> ApiError {
    // A denial from the OS is the interesting case: on macOS it means the
    // user said no to the keychain prompt, or the application's signature
    // changed and the item no longer trusts it.
    let code = match error {
        keyring::Error::NoEntry => code::NOT_FOUND,
        _ => code::IO_ERROR,
    };
    ApiError::new(
        code,
        format!("Could not {action} the secret `{key}`: {error}"),
    )
}
