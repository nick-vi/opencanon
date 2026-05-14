use serde::{Deserialize, Serialize};

pub(crate) fn decode<T: for<'de> Deserialize<'de>>(value: &str) -> napi::Result<T> {
    serde_json::from_str(value)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))
}

pub(crate) fn encode<T: Serialize>(value: &T) -> napi::Result<String> {
    serde_json::to_string(value)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))
}

pub(crate) fn napi_error(code: &str, message: &str) -> napi::Error {
    napi::Error::new(napi::Status::GenericFailure, format!("[{code}] {message}"))
}

pub(crate) fn sqlite_error(context: &str, error: rusqlite::Error) -> napi::Error {
    napi_error("sqlite-error", &format!("{context}: {error}"))
}

pub(crate) fn notify_error(context: &str, error: notify::Error) -> napi::Error {
    napi_error("watcher-error", &format!("{context}: {error}"))
}
