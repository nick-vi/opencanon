use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::json::napi_error;

pub(super) fn root_path(root_dir: &str, file: &str) -> PathBuf {
    Path::new(root_dir).join(file)
}

pub(super) fn json_object_field<'a>(
    value: &'a Value,
    field: &str,
) -> napi::Result<&'a serde_json::Map<String, Value>> {
    value.get(field).and_then(Value::as_object).ok_or_else(|| {
        napi_error(
            "invalid-engine-payload",
            &format!("Product model projection is missing object field {field}."),
        )
    })
}

pub(super) fn json_array_field<'a>(
    value: &'a serde_json::Map<String, Value>,
    field: &str,
) -> napi::Result<&'a Vec<Value>> {
    value.get(field).and_then(Value::as_array).ok_or_else(|| {
        napi_error(
            "invalid-engine-payload",
            &format!("Product model projection is missing array field {field}."),
        )
    })
}

pub(super) fn json_string_field<'a>(value: &'a Value, field: &str) -> napi::Result<&'a str> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        napi_error(
            "invalid-engine-payload",
            &format!("Product model projection is missing string field {field}."),
        )
    })
}

pub(super) fn json_optional_string_field<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

pub(super) fn json_bool_field(value: &Value, field: &str) -> napi::Result<bool> {
    value.get(field).and_then(Value::as_bool).ok_or_else(|| {
        napi_error(
            "invalid-engine-payload",
            &format!("JSON payload is missing boolean field {field}."),
        )
    })
}

pub(super) fn json_optional_bool_field(value: &Value, field: &str) -> Option<bool> {
    value.get(field).and_then(Value::as_bool)
}

pub(super) fn json_optional_f64_field(value: &Value, field: &str) -> Option<f64> {
    value.get(field).and_then(Value::as_f64)
}

pub(super) fn json_payload_field(value: &Value, field: &str) -> napi::Result<String> {
    let payload = value.get(field).ok_or_else(|| {
        napi_error(
            "invalid-engine-payload",
            &format!("JSON payload is missing field {field}."),
        )
    })?;
    json_payload(payload)
}

pub(super) fn json_optional_payload_field(
    value: &Value,
    field: &str,
) -> napi::Result<Option<String>> {
    match value.get(field) {
        Some(Value::Null) | None => Ok(None),
        Some(payload) => json_payload(payload).map(Some),
    }
}

pub(super) fn json_payload(value: &Value) -> napi::Result<String> {
    serde_json::to_string(value).map_err(|error| {
        napi_error(
            "invalid-engine-payload",
            &format!("Could not serialize JSON payload: {error}"),
        )
    })
}

pub(super) fn json_int_field(
    value: &serde_json::Map<String, Value>,
    field: &str,
) -> napi::Result<i64> {
    value.get(field).and_then(Value::as_i64).ok_or_else(|| {
        napi_error(
            "invalid-engine-payload",
            &format!("Product model projection is missing integer field {field}."),
        )
    })
}

pub(super) fn stable_projection_row_id(parts: &[&str]) -> String {
    let mut hasher = blake3::Hasher::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update(b"\0");
    }
    hasher.finalize().to_hex().to_string()
}
