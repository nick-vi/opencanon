mod constants;
mod contracts;
mod facts;
mod json;
mod project;
mod state;
mod watcher;

use constants::{ENGINE_VERSION, NAPI_VERSION, SCHEMA_VERSION};
use contracts::OpenProjectRequest;
use json::{decode, encode};
use napi_derive::napi;
use serde_json::json;

pub use project::EngineProjectHandle;

#[napi(js_name = "versionJson")]
pub fn version_json() -> napi::Result<String> {
    encode(&json!({
      "packageVersion": env!("CARGO_PKG_VERSION"),
      "engineVersion": ENGINE_VERSION,
      "napiVersion": NAPI_VERSION,
      "schemaVersion": SCHEMA_VERSION,
    }))
}

#[napi(js_name = "openProjectJson")]
pub fn open_project_json(request: String) -> napi::Result<EngineProjectHandle> {
    let request: OpenProjectRequest = decode(&request)?;
    EngineProjectHandle::open(request)
}

#[cfg(test)]
mod tests;
