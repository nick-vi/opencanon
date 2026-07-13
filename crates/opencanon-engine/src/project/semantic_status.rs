use serde_json::{json, Value};

use super::semantic_vector_store::semantic_vector_publication_failure_locked;
use super::EngineProjectHandle;

pub(super) fn inspect_semantic_vector_health(
    handle: &EngineProjectHandle,
    index_id: &str,
    mut index: Value,
) -> Value {
    if index.get("status").and_then(Value::as_str) != Some("ready") {
        return index;
    }

    let failure = semantic_vector_publication_failure_locked(&handle.state_path, index_id, &index);

    let Some(message) = failure else {
        return index;
    };
    let chunk_count = index.get("chunkCount").and_then(Value::as_u64).unwrap_or(0);
    if let Some(object) = index.as_object_mut() {
        object.insert("status".to_string(), Value::String("stale".to_string()));
        object.insert("vectorCount".to_string(), Value::from(0));
        object.insert("staleChunkCount".to_string(), Value::from(chunk_count));
        let diagnostics = object
            .entry("diagnostics".to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Some(diagnostics) = diagnostics.as_array_mut() {
            diagnostics.push(json!({
                "code": "semantic-vector-rebuild-required",
                "message": format!("{message} Rebuild Project Knowledge before semantic search."),
                "severity": "warning"
            }));
        }
    }
    index
}
