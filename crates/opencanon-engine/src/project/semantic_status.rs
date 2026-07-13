use opencanon_vector::{Config as VectorConfig, EmbeddingDb};
use serde_json::{json, Value};

use super::semantic_store::semantic_vector_dir;
use super::EngineProjectHandle;

pub(super) fn inspect_semantic_vector_health(
    handle: &EngineProjectHandle,
    index_id: &str,
    mut index: Value,
) -> Value {
    if index.get("status").and_then(Value::as_str) != Some("ready") {
        return index;
    }

    let expected_dimensions = index
        .get("provider")
        .and_then(Value::as_object)
        .and_then(|provider| provider.get("dimensions"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok());
    let expected_vectors = index
        .get("vectorCount")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok());
    let vector_dir = semantic_vector_dir(&handle.state_path, index_id);
    let failure = match (expected_dimensions, expected_vectors) {
        (Some(dimensions), Some(vector_count)) if vector_dir.exists() => {
            match EmbeddingDb::open_with_config(
                &vector_dir,
                Some(VectorConfig::with_dimensions(dimensions)),
            ) {
                Ok(db) if db.len() == vector_count => None,
                Ok(db) => Some(format!(
                    "Semantic vector count mismatch: expected {vector_count}, got {}.",
                    db.len()
                )),
                Err(error) => Some(format!("Semantic vector store is unreadable: {error}")),
            }
        }
        (Some(_), Some(_)) => Some("Semantic vector store is missing.".to_string()),
        _ => Some("Semantic index metadata does not describe its vector store.".to_string()),
    };

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
