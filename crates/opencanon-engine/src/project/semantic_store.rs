use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use opencanon_inference::{GenerateOptions, InferenceError};
use opencanon_vector::{Config as VectorConfig, EmbedDbError, EmbeddingDb};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::contracts::{
    EmbedSemanticTextsRequest, GenerateTextRequest, ListSemanticChunksRequest,
    ReadSemanticIndexStatusRequest, SearchSemanticIndexRequest, SemanticChunkEmbeddingRequest,
    SemanticIndexNodeRequest, WriteSemanticIndexDeltaRequest, WriteSemanticIndexRequest,
};
use crate::json::{decode, encode, napi_error, sqlite_error};
use crate::state::timestamp;

use super::json_fields::{json_int_field, json_object_field};
use super::EngineProjectHandle;

pub(super) fn default_knowledge_index_id() -> &'static str {
    "project"
}

pub(super) fn semantic_vector_dir(state_path: &str, index_id: &str) -> PathBuf {
    let parent = Path::new(state_path)
        .parent()
        .unwrap_or_else(|| Path::new("."));
    parent
        .join("semantic-index")
        .join(sanitize_state_segment(index_id))
}

fn sanitize_state_segment(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
            output.push(character);
        } else {
            output.push('_');
        }
    }
    if output.is_empty() {
        default_knowledge_index_id().to_string()
    } else {
        output
    }
}

pub(super) fn validate_knowledge_index_request(
    request: &WriteSemanticIndexRequest,
) -> napi::Result<()> {
    validate_knowledge_index_snapshot(&request.index)?;
    if request.index.chunk_count as usize != request.chunks.len()
        || request.index.vector_count as usize != request.chunks.len()
    {
        return Err(napi_error(
            "invalid-engine-payload",
            &format!(
                "Semantic index counts must match chunk payload length: chunkCount={}, vectorCount={}, chunks={}.",
                request.index.chunk_count,
                request.index.vector_count,
                request.chunks.len()
            ),
        ));
    }
    validate_knowledge_chunks(&request.chunks, request.index.provider.dimensions)
}

pub(super) fn validate_knowledge_index_delta_request(
    request: &WriteSemanticIndexDeltaRequest,
) -> napi::Result<()> {
    validate_knowledge_index_snapshot(&request.index)?;
    validate_knowledge_chunks(&request.chunks, request.index.provider.dimensions)?;
    for path in request.removed_paths.iter() {
        if path.trim().is_empty() {
            return Err(napi_error(
                "invalid-engine-payload",
                "Semantic index removed paths must not be empty.",
            ));
        }
    }
    for key in request.removed_node_keys.iter() {
        if key.trim().is_empty() {
            return Err(napi_error(
                "invalid-engine-payload",
                "Semantic index removed node keys must not be empty.",
            ));
        }
    }
    Ok(())
}

fn validate_knowledge_index_snapshot(
    index: &crate::contracts::SemanticIndexSnapshotRequest,
) -> napi::Result<()> {
    if index.id.trim().is_empty() {
        return Err(napi_error(
            "invalid-engine-payload",
            "Semantic index id is required.",
        ));
    }
    if index.provider.dimensions == 0 {
        return Err(napi_error(
            "invalid-engine-payload",
            "Semantic index dimensions must be positive.",
        ));
    }
    if index.provider.kind.trim().is_empty() || index.chunk_tree_hash.trim().is_empty() {
        return Err(napi_error(
            "invalid-engine-payload",
            "Semantic index provider kind and chunk tree hash are required.",
        ));
    }
    if index.provider.distance != "cosine" {
        return Err(napi_error(
            "invalid-engine-payload",
            "Semantic index distance must be cosine.",
        ));
    }
    Ok(())
}

fn validate_knowledge_chunks(
    chunks: &[SemanticChunkEmbeddingRequest],
    dimensions: u32,
) -> napi::Result<()> {
    for chunk in chunks.iter() {
        if !chunk.vector.is_empty() && chunk.vector.len() != dimensions as usize {
            return Err(napi_error(
                "invalid-engine-payload",
                &format!(
                    "Semantic chunk {} vector dimension mismatch: expected {}, got {}.",
                    chunk.metadata.id,
                    dimensions,
                    chunk.vector.len()
                ),
            ));
        }
        if chunk.metadata.id.trim().is_empty()
            || chunk.metadata.path.trim().is_empty()
            || chunk.metadata.chunk_hash.trim().is_empty()
            || chunk.metadata.embedding_hash.trim().is_empty()
            || chunk.text.trim().is_empty()
        {
            return Err(napi_error(
                "invalid-engine-payload",
                "Semantic chunk metadata or search text is missing required identity fields.",
            ));
        }
    }
    Ok(())
}

pub(super) fn read_knowledge_index_payload(
    conn: &Connection,
    root_dir: &str,
    index_id: &str,
) -> napi::Result<Option<Value>> {
    let payload = conn
        .query_row(
            "select payload from knowledge_snapshots where root_dir = ?1 and id = ?2",
            params![root_dir, index_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| sqlite_error("Could not read semantic index snapshot", error))?;
    payload
        .map(|payload| {
            serde_json::from_str::<Value>(&payload)
                .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))
        })
        .transpose()
}

pub(super) fn read_semantic_chunk_payload(
    conn: &Connection,
    root_dir: &str,
    index_id: &str,
    chunk_id: &str,
) -> napi::Result<Option<Value>> {
    let payload = conn
        .query_row(
            "select payload from knowledge_chunks where root_dir = ?1 and index_id = ?2 and id = ?3",
            params![root_dir, index_id, chunk_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| sqlite_error("Could not read semantic chunk", error))?;
    payload
        .map(|payload| {
            serde_json::from_str::<Value>(&payload)
                .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))
        })
        .transpose()
}

pub(super) fn list_semantic_chunk_payloads(
    conn: &Connection,
    root_dir: &str,
    index_id: &str,
    paths: &[String],
    limit: usize,
    offset: usize,
) -> napi::Result<Vec<Value>> {
    if paths.is_empty() {
        let mut statement = conn
            .prepare(
                "select payload from knowledge_chunks
                 where root_dir = ?1 and index_id = ?2
                 order by path, cast(json_extract(payload, '$.ordinal') as integer), id
                 limit ?3 offset ?4",
            )
            .map_err(|error| sqlite_error("Could not prepare semantic chunk list", error))?;
        let rows = statement
            .query_map(
                params![root_dir, index_id, limit as i64, offset as i64],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| sqlite_error("Could not list semantic chunks", error))?;
        let mut chunks = Vec::new();
        for row in rows {
            let payload =
                row.map_err(|error| sqlite_error("Could not decode semantic chunk", error))?;
            chunks.push(
                serde_json::from_str::<Value>(&payload)
                    .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?,
            );
        }
        return Ok(chunks);
    }

    let allowed_paths = paths.iter().cloned().collect::<HashSet<_>>();
    let mut statement = conn
        .prepare(
            "select payload from knowledge_chunks
             where root_dir = ?1 and index_id = ?2
             order by path, cast(json_extract(payload, '$.ordinal') as integer), id",
        )
        .map_err(|error| sqlite_error("Could not prepare filtered semantic chunk list", error))?;
    let rows = statement
        .query_map(params![root_dir, index_id], |row| row.get::<_, String>(0))
        .map_err(|error| sqlite_error("Could not list filtered semantic chunks", error))?;
    let mut chunks = Vec::new();
    for row in rows {
        let payload =
            row.map_err(|error| sqlite_error("Could not decode semantic chunk", error))?;
        let chunk = serde_json::from_str::<Value>(&payload)
            .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
        let Some(path) = chunk.get("path").and_then(Value::as_str) else {
            continue;
        };
        if allowed_paths.contains(path) {
            chunks.push(chunk);
        }
    }
    Ok(chunks.into_iter().skip(offset).take(limit).collect())
}

pub(super) fn read_semantic_chunk_hashes(
    conn: &Connection,
    root_dir: &str,
    index_id: &str,
) -> napi::Result<HashMap<String, String>> {
    let mut statement = conn
        .prepare(
            "select id, embedding_hash from knowledge_chunks where root_dir = ?1 and index_id = ?2",
        )
        .map_err(|error| sqlite_error("Could not prepare semantic chunk hash read", error))?;
    let rows = statement
        .query_map(params![root_dir, index_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| sqlite_error("Could not read semantic chunk hashes", error))?;
    let mut hashes = HashMap::new();
    for row in rows {
        let (id, hash) =
            row.map_err(|error| sqlite_error("Could not decode semantic chunk hash", error))?;
        hashes.insert(id, hash);
    }
    Ok(hashes)
}

pub(super) fn write_semantic_vectors(
    vector_db: &mut EmbeddingDb,
    existing_chunks: &HashMap<String, String>,
    incoming_ids: &HashSet<String>,
    chunks: &[SemanticChunkEmbeddingRequest],
) -> Result<(), EmbedDbError> {
    for existing_id in existing_chunks.keys() {
        if !incoming_ids.contains(existing_id) {
            vector_db.delete(existing_id)?;
        }
    }

    let mut insert_ids = Vec::new();
    let mut insert_vectors = Vec::new();
    for chunk in chunks {
        let existing_hash = existing_chunks.get(&chunk.metadata.id);
        if existing_hash == Some(&chunk.metadata.embedding_hash) {
            continue;
        }
        if existing_hash.is_some() {
            vector_db.delete(&chunk.metadata.id)?;
        }
        insert_ids.push(chunk.metadata.id.clone());
        insert_vectors.push(chunk.vector.clone());
    }
    vector_db.insert_batch(&insert_ids, &insert_vectors)?;
    vector_db.flush()?;
    Ok(())
}

pub(super) fn write_semantic_vector_delta(
    vector_db: &mut EmbeddingDb,
    existing_chunks: &HashMap<String, String>,
    removed_ids: &[String],
    chunks: &[SemanticChunkEmbeddingRequest],
) -> Result<(), EmbedDbError> {
    for removed_id in removed_ids {
        vector_db.delete(removed_id)?;
    }

    let mut insert_ids = Vec::new();
    let mut insert_vectors = Vec::new();
    for chunk in chunks {
        let existing_hash = existing_chunks.get(&chunk.metadata.id);
        if existing_hash == Some(&chunk.metadata.embedding_hash) {
            continue;
        }
        if existing_hash.is_some() {
            vector_db.delete(&chunk.metadata.id)?;
        }
        insert_ids.push(chunk.metadata.id.clone());
        insert_vectors.push(chunk.vector.clone());
    }
    vector_db.insert_batch(&insert_ids, &insert_vectors)?;
    vector_db.flush()?;
    Ok(())
}

pub(super) fn semantic_vector_error_is_recoverable(error: &EmbedDbError) -> bool {
    matches!(
        error,
        EmbedDbError::Corrupted(_) | EmbedDbError::DuplicateId(_) | EmbedDbError::Io(_)
    )
}

pub(super) fn semantic_chunk_ids_for_paths(
    conn: &Connection,
    root_dir: &str,
    index_id: &str,
    paths: &[String],
) -> napi::Result<Vec<String>> {
    let mut ids = Vec::new();
    for path in paths {
        let mut statement = conn
            .prepare(
                "select id from knowledge_chunks where root_dir = ?1 and index_id = ?2 and path = ?3",
            )
            .map_err(|error| sqlite_error("Could not prepare semantic chunk filter", error))?;
        let rows = statement
            .query_map(params![root_dir, index_id, path], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| sqlite_error("Could not filter semantic chunks", error))?;
        for row in rows {
            ids.push(
                row.map_err(|error| sqlite_error("Could not decode semantic chunk id", error))?,
            );
        }
    }
    Ok(ids)
}

pub(super) fn semantic_lexical_matches(
    conn: &Connection,
    root_dir: &str,
    index_id: &str,
    query: &str,
    limit: usize,
) -> napi::Result<Vec<(String, f64)>> {
    let Some(match_query) = semantic_fts_query(query) else {
        return Ok(Vec::new());
    };
    let mut statement = conn
        .prepare(
            "select id, bm25(knowledge_chunks_fts) as rank
             from knowledge_chunks_fts
             where knowledge_chunks_fts match ?1 and root_dir = ?2 and index_id = ?3
             order by rank
             limit ?4",
        )
        .map_err(|error| sqlite_error("Could not prepare semantic lexical search", error))?;
    let rows = statement
        .query_map(
            params![match_query, root_dir, index_id, limit as i64],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?)),
        )
        .map_err(|error| sqlite_error("Could not run semantic lexical search", error))?;
    let mut matches = Vec::new();
    for row in rows {
        matches.push(row.map_err(|error| sqlite_error("Could not decode lexical match", error))?);
    }
    Ok(matches)
}

fn semantic_fts_query(query: &str) -> Option<String> {
    let mut terms = Vec::new();
    let mut current = String::new();
    for character in query.chars() {
        if character.is_ascii_alphanumeric() || character == '_' {
            current.push(character.to_ascii_lowercase());
        } else if current.len() > 1 {
            terms.push(std::mem::take(&mut current));
        } else {
            current.clear();
        }
    }
    if current.len() > 1 {
        terms.push(current);
    }
    terms.sort();
    terms.dedup();
    if terms.is_empty() {
        return None;
    }
    Some(
        terms
            .into_iter()
            .take(16)
            .map(|term| format!("{term}*"))
            .collect::<Vec<_>>()
            .join(" OR "),
    )
}

pub(super) fn generation_options(request: &GenerateTextRequest) -> napi::Result<GenerateOptions> {
    let defaults = GenerateOptions::default();
    let max_tokens = request.max_tokens.unwrap_or(defaults.max_tokens);
    if max_tokens == 0 || max_tokens > 4096 {
        return Err(napi_error(
            "invalid-engine-payload",
            "Generation maxTokens must be between 1 and 4096.",
        ));
    }
    let temperature = request.temperature.unwrap_or(defaults.temperature);
    if !(0.0..=2.0).contains(&temperature) {
        return Err(napi_error(
            "invalid-engine-payload",
            "Generation temperature must be between 0 and 2.",
        ));
    }
    let top_p = request.top_p.unwrap_or(defaults.top_p);
    if !(0.0..=1.0).contains(&top_p) {
        return Err(napi_error(
            "invalid-engine-payload",
            "Generation topP must be between 0 and 1.",
        ));
    }
    if request.n_threads.is_some_and(|value| value <= 0) {
        return Err(napi_error(
            "invalid-engine-payload",
            "Generation nThreads must be a positive integer.",
        ));
    }
    if request.n_ctx.is_some_and(|value| value == 0) {
        return Err(napi_error(
            "invalid-engine-payload",
            "Generation nCtx must be a positive integer.",
        ));
    }
    Ok(GenerateOptions {
        max_tokens,
        temperature,
        top_p,
        seed: request.seed.unwrap_or(defaults.seed),
    })
}

pub(super) fn vector_error(error: EmbedDbError) -> napi::Error {
    napi_error("invalid-engine-payload", &error.to_string())
}

pub(super) fn inference_error(error: InferenceError) -> napi::Error {
    napi_error("inference-error", &error.to_string())
}

fn replace_semantic_nodes(
    tx: &rusqlite::Transaction<'_>,
    root_dir: &str,
    index_id: &str,
    nodes: &[SemanticIndexNodeRequest],
) -> napi::Result<()> {
    tx.execute(
        "delete from knowledge_nodes where root_dir = ?1 and index_id = ?2",
        params![root_dir, index_id],
    )
    .map_err(|error| sqlite_error("Could not reset knowledge nodes", error))?;
    upsert_semantic_nodes(tx, root_dir, index_id, nodes)
}

pub(super) fn delete_semantic_nodes(
    tx: &rusqlite::Transaction<'_>,
    root_dir: &str,
    index_id: &str,
    removed_paths: &[String],
    removed_node_keys: &[String],
) -> napi::Result<()> {
    for key in removed_node_keys {
        tx.execute(
            "delete from knowledge_nodes where root_dir = ?1 and index_id = ?2 and key = ?3",
            params![root_dir, index_id, key],
        )
        .map_err(|error| sqlite_error("Could not delete knowledge node", error))?;
    }
    for path in removed_paths {
        let child_pattern = format!("{path}#%");
        tx.execute(
            "delete from knowledge_nodes where root_dir = ?1 and index_id = ?2 and (key = ?3 or key like ?4)",
            params![root_dir, index_id, path, child_pattern],
        )
        .map_err(|error| sqlite_error("Could not delete knowledge nodes for removed path", error))?;
    }
    Ok(())
}

pub(super) fn upsert_semantic_nodes(
    tx: &rusqlite::Transaction<'_>,
    root_dir: &str,
    index_id: &str,
    nodes: &[SemanticIndexNodeRequest],
) -> napi::Result<()> {
    let updated_at = timestamp();
    for node in nodes {
        let children = serde_json::to_string(&node.children)
            .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
        tx.execute(
            "insert into knowledge_nodes(root_dir, index_id, key, kind, hash, parent_key, children, updated_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             on conflict(root_dir, index_id, key) do update set
               kind = excluded.kind,
               hash = excluded.hash,
               parent_key = excluded.parent_key,
               children = excluded.children,
               updated_at = excluded.updated_at",
            params![
                root_dir,
                index_id,
                node.key,
                node.kind,
                node.hash,
                node.parent_key,
                children,
                updated_at,
            ],
        )
        .map_err(|error| sqlite_error("Could not upsert knowledge node", error))?;
    }
    Ok(())
}

pub(super) fn assert_semantic_chunk_count(
    tx: &rusqlite::Transaction<'_>,
    root_dir: &str,
    index_id: &str,
    expected: u32,
) -> napi::Result<()> {
    let actual: i64 = tx
        .query_row(
            "select count(*) from knowledge_chunks where root_dir = ?1 and index_id = ?2",
            params![root_dir, index_id],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("Could not verify semantic chunk count", error))?;
    if actual != expected as i64 {
        return Err(napi_error(
            "invalid-engine-payload",
            &format!(
                "Semantic index chunkCount={} does not match stored chunk count {} after write.",
                expected, actual
            ),
        ));
    }
    Ok(())
}

pub(super) fn upsert_semantic_chunk_rows(
    tx: &rusqlite::Transaction<'_>,
    root_dir: &str,
    index_id: &str,
    indexed_at: &str,
    chunks: &[SemanticChunkEmbeddingRequest],
) -> napi::Result<()> {
    for chunk in chunks.iter() {
        let metadata = &chunk.metadata;
        let payload = serde_json::to_string(metadata)
            .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
        tx.execute(
                "insert into knowledge_chunks(root_dir, index_id, id, path, content_hash, chunk_hash,
                   embedding_hash, kind, language, ordinal, start_line, start_column, start_byte,
                   end_line, end_column, end_byte, heading, symbol, token_estimate, preview, payload, indexed_at, text)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
                 on conflict(root_dir, index_id, id) do update set
                   path = excluded.path,
                   content_hash = excluded.content_hash,
                   chunk_hash = excluded.chunk_hash,
                   embedding_hash = excluded.embedding_hash,
                   kind = excluded.kind,
                   language = excluded.language,
                   ordinal = excluded.ordinal,
                   start_line = excluded.start_line,
                   start_column = excluded.start_column,
                   start_byte = excluded.start_byte,
                   end_line = excluded.end_line,
                   end_column = excluded.end_column,
                   end_byte = excluded.end_byte,
                   heading = excluded.heading,
                   symbol = excluded.symbol,
                   token_estimate = excluded.token_estimate,
                   preview = excluded.preview,
                   payload = excluded.payload,
                   indexed_at = excluded.indexed_at,
                   text = excluded.text",
                params![
                    root_dir,
                    index_id,
                    metadata.id,
                    metadata.path,
                    metadata.content_hash,
                    metadata.chunk_hash,
                    metadata.embedding_hash,
                    metadata.kind,
                    metadata.language,
                    metadata.ordinal,
                    metadata.range.start.line,
                    metadata.range.start.column,
                    metadata.range.start.byte,
                    metadata.range.end.line,
                    metadata.range.end.column,
                    metadata.range.end.byte,
                    metadata.heading,
                    metadata.symbol,
                    metadata.token_estimate,
                    metadata.preview,
                    payload,
                    indexed_at,
                    chunk.text,
                ],
            )
            .map_err(|error| sqlite_error("Could not write semantic chunk metadata", error))?;
        tx.execute(
                "insert into knowledge_chunks_fts(root_dir, index_id, id, path, heading, symbol, language, kind, preview, text)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    root_dir,
                    index_id,
                    metadata.id,
                    metadata.path,
                    metadata.heading,
                    metadata.symbol,
                    metadata.language,
                    metadata.kind,
                    metadata.preview,
                    chunk.text,
                ],
            )
            .map_err(|error| sqlite_error("Could not write semantic search text", error))?;
    }
    Ok(())
}

pub(super) fn write_knowledge_index_json(
    handle: &EngineProjectHandle,
    request: String,
) -> napi::Result<()> {
    let request: WriteSemanticIndexRequest = decode(&request)?;
    validate_knowledge_index_request(&request)?;

    let mut conn = handle
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let previous_index = read_knowledge_index_payload(&conn, &handle.root_dir, &request.index.id)?;
    let previous_identity = previous_index
        .as_ref()
        .and_then(|index| index.get("identityHash"))
        .and_then(Value::as_str);
    let mut existing_chunks =
        read_semantic_chunk_hashes(&conn, &handle.root_dir, &request.index.id)?;
    let incoming_ids = request
        .chunks
        .iter()
        .map(|chunk| chunk.metadata.id.clone())
        .collect::<HashSet<_>>();
    let vector_dir = semantic_vector_dir(&handle.state_path, &request.index.id);
    let reset_vectors =
        previous_identity != Some(request.index.identity_hash.as_str()) || !vector_dir.exists();
    let mut reset_sql_chunks = reset_vectors;
    let vector_config = VectorConfig::with_dimensions(request.index.provider.dimensions as usize);
    if reset_vectors && vector_dir.exists() {
        fs::remove_dir_all(&vector_dir).map_err(|error| {
            napi_error(
                "invalid-engine-payload",
                &format!("Could not reset semantic vector store: {error}"),
            )
        })?;
    }
    let mut vector_db = if reset_vectors {
        fs::create_dir_all(&vector_dir).map_err(|error| {
            napi_error(
                "invalid-engine-payload",
                &format!("Could not create semantic vector store: {error}"),
            )
        })?;
        existing_chunks.clear();
        EmbeddingDb::create(&vector_dir, vector_config.clone()).map_err(vector_error)?
    } else {
        match EmbeddingDb::open_with_config(&vector_dir, Some(vector_config.clone())) {
            Ok(db) => db,
            Err(error) => {
                fs::remove_dir_all(&vector_dir).map_err(|remove_error| {
                        napi_error(
                            "invalid-engine-payload",
                            &format!(
                                "Could not recover corrupted semantic vector store after open error ({error}): {remove_error}"
                            ),
                        )
                    })?;
                fs::create_dir_all(&vector_dir).map_err(|create_error| {
                        napi_error(
                            "invalid-engine-payload",
                            &format!(
                                "Could not recreate semantic vector store after open error ({error}): {create_error}"
                            ),
                        )
                    })?;
                existing_chunks.clear();
                reset_sql_chunks = true;
                EmbeddingDb::create(&vector_dir, vector_config.clone()).map_err(vector_error)?
            }
        }
    };

    for chunk in request.chunks.iter() {
        let existing_hash = existing_chunks.get(&chunk.metadata.id);
        if existing_hash != Some(&chunk.metadata.embedding_hash) && chunk.vector.is_empty() {
            return Err(napi_error(
                "invalid-engine-payload",
                &format!(
                    "Semantic chunk {} cannot reuse a missing or changed vector.",
                    chunk.metadata.id
                ),
            ));
        }
    }

    if let Err(error) = write_semantic_vectors(
        &mut vector_db,
        &existing_chunks,
        &incoming_ids,
        &request.chunks,
    ) {
        if !semantic_vector_error_is_recoverable(&error)
            || request.chunks.iter().any(|chunk| chunk.vector.is_empty())
        {
            return Err(vector_error(error));
        }
        if vector_dir.exists() {
            fs::remove_dir_all(&vector_dir).map_err(|remove_error| {
                    napi_error(
                        "invalid-engine-payload",
                        &format!(
                            "Could not recover corrupted semantic vector store after write error ({error}): {remove_error}"
                        ),
                    )
                })?;
        }
        fs::create_dir_all(&vector_dir).map_err(|create_error| {
                napi_error(
                    "invalid-engine-payload",
                    &format!(
                        "Could not recreate semantic vector store after write error ({error}): {create_error}"
                    ),
                )
            })?;
        let mut recovered_vector_db =
            EmbeddingDb::create(&vector_dir, vector_config.clone()).map_err(vector_error)?;
        existing_chunks.clear();
        reset_sql_chunks = true;
        write_semantic_vectors(
            &mut recovered_vector_db,
            &existing_chunks,
            &incoming_ids,
            &request.chunks,
        )
        .map_err(vector_error)?;
    }

    let indexed_at = request.index.indexed_at.clone();
    let diagnostics_json = serde_json::to_string(&request.index.diagnostics)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
    let index_payload = serde_json::to_string(&request.index)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;

    let tx = conn
        .transaction()
        .map_err(|error| sqlite_error("Could not start semantic index transaction", error))?;
    tx.execute(
            "insert into knowledge_snapshots(root_dir, id, version, status, provider_id,
               provider_display_name, model_id, model_digest, dimensions, distance, config_hash,
               chunker_version, producer_version, source_inventory_hash, identity_hash, chunk_count,
               vector_count, stale_chunk_count, diagnostics, payload, indexed_at, updated_at, chunk_tree_hash)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
             on conflict(root_dir, id) do update set
               version = excluded.version,
               status = excluded.status,
               provider_id = excluded.provider_id,
               provider_display_name = excluded.provider_display_name,
               model_id = excluded.model_id,
               model_digest = excluded.model_digest,
               dimensions = excluded.dimensions,
               distance = excluded.distance,
               config_hash = excluded.config_hash,
               chunker_version = excluded.chunker_version,
               producer_version = excluded.producer_version,
               source_inventory_hash = excluded.source_inventory_hash,
               identity_hash = excluded.identity_hash,
               chunk_count = excluded.chunk_count,
               vector_count = excluded.vector_count,
               stale_chunk_count = excluded.stale_chunk_count,
               diagnostics = excluded.diagnostics,
               payload = excluded.payload,
               indexed_at = excluded.indexed_at,
               updated_at = excluded.updated_at,
               chunk_tree_hash = excluded.chunk_tree_hash",
            params![
                handle.root_dir,
                request.index.id,
                request.index.version,
                request.index.status,
                request.index.provider.id,
                request.index.provider.display_name,
                request.index.provider.model_id,
                request.index.provider.model_digest,
                request.index.provider.dimensions,
                request.index.provider.distance,
                request.index.provider.config_hash,
                request.index.chunker_version,
                request.index.producer_version,
                request.index.source_inventory_hash,
                request.index.identity_hash,
                request.index.chunk_count,
                request.index.vector_count,
                request.index.stale_chunk_count,
                diagnostics_json,
                index_payload,
                indexed_at,
                timestamp(),
                request.index.chunk_tree_hash,
            ],
        )
        .map_err(|error| sqlite_error("Could not write semantic index snapshot", error))?;

    if reset_sql_chunks {
        tx.execute(
            "delete from knowledge_chunks where root_dir = ?1 and index_id = ?2",
            params![handle.root_dir, request.index.id],
        )
        .map_err(|error| sqlite_error("Could not reset semantic chunks", error))?;
    } else {
        for removed_id in existing_chunks.keys() {
            if incoming_ids.contains(removed_id) {
                continue;
            }
            tx.execute(
                "delete from knowledge_chunks where root_dir = ?1 and index_id = ?2 and id = ?3",
                params![handle.root_dir, request.index.id, removed_id],
            )
            .map_err(|error| sqlite_error("Could not delete stale semantic chunk", error))?;
        }
    }
    tx.execute(
        "delete from knowledge_chunks_fts where root_dir = ?1 and index_id = ?2",
        params![handle.root_dir, request.index.id],
    )
    .map_err(|error| sqlite_error("Could not clear semantic search text", error))?;

    for chunk in request.chunks.iter() {
        let metadata = &chunk.metadata;
        let payload = serde_json::to_string(metadata)
            .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
        tx.execute(
                "insert into knowledge_chunks(root_dir, index_id, id, path, content_hash, chunk_hash,
                   embedding_hash, kind, language, ordinal, start_line, start_column, start_byte,
                   end_line, end_column, end_byte, heading, symbol, token_estimate, preview, payload, indexed_at, text)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
                 on conflict(root_dir, index_id, id) do update set
                   path = excluded.path,
                   content_hash = excluded.content_hash,
                   chunk_hash = excluded.chunk_hash,
                   embedding_hash = excluded.embedding_hash,
                   kind = excluded.kind,
                   language = excluded.language,
                   ordinal = excluded.ordinal,
                   start_line = excluded.start_line,
                   start_column = excluded.start_column,
                   start_byte = excluded.start_byte,
                   end_line = excluded.end_line,
                   end_column = excluded.end_column,
                   end_byte = excluded.end_byte,
                   heading = excluded.heading,
                   symbol = excluded.symbol,
                   token_estimate = excluded.token_estimate,
                   preview = excluded.preview,
                   payload = excluded.payload,
                   indexed_at = excluded.indexed_at,
                   text = excluded.text",
                params![
                    handle.root_dir,
                    request.index.id,
                    metadata.id,
                    metadata.path,
                    metadata.content_hash,
                    metadata.chunk_hash,
                    metadata.embedding_hash,
                    metadata.kind,
                    metadata.language,
                    metadata.ordinal,
                    metadata.range.start.line,
                    metadata.range.start.column,
                    metadata.range.start.byte,
                    metadata.range.end.line,
                    metadata.range.end.column,
                    metadata.range.end.byte,
                    metadata.heading,
                    metadata.symbol,
                    metadata.token_estimate,
                    metadata.preview,
                    payload,
                    indexed_at,
                    chunk.text,
                ],
            )
            .map_err(|error| sqlite_error("Could not write semantic chunk metadata", error))?;
        tx.execute(
                "insert into knowledge_chunks_fts(root_dir, index_id, id, path, heading, symbol, language, kind, preview, text)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    handle.root_dir,
                    request.index.id,
                    metadata.id,
                    metadata.path,
                    metadata.heading,
                    metadata.symbol,
                    metadata.language,
                    metadata.kind,
                    metadata.preview,
                    chunk.text,
                ],
            )
            .map_err(|error| sqlite_error("Could not write semantic search text", error))?;
    }

    replace_semantic_nodes(&tx, &handle.root_dir, &request.index.id, &request.nodes)?;
    assert_semantic_chunk_count(
        &tx,
        &handle.root_dir,
        &request.index.id,
        request.index.chunk_count,
    )?;

    tx.commit()
        .map_err(|error| sqlite_error("Could not commit semantic index transaction", error))?;
    Ok(())
}

pub(super) fn read_knowledge_index_status_json(
    handle: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: ReadSemanticIndexStatusRequest = decode(&request)?;
    let index_id = request
        .index_id
        .unwrap_or_else(|| default_knowledge_index_id().to_string());
    let conn = handle
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let index = read_knowledge_index_payload(&conn, &handle.root_dir, &index_id)?.map(|index| {
        super::semantic_status::inspect_semantic_vector_health(handle, &index_id, index)
    });
    encode(&json!({ "index": index }))
}

pub(super) fn list_knowledge_chunks_json(
    handle: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: ListSemanticChunksRequest = decode(&request)?;
    let index_id = request
        .index_id
        .unwrap_or_else(|| default_knowledge_index_id().to_string());
    let limit = request.limit.unwrap_or(100).clamp(1, 500) as usize;
    let offset = request.offset.unwrap_or(0) as usize;
    let conn = handle
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let Some(index) = read_knowledge_index_payload(&conn, &handle.root_dir, &index_id)? else {
        return encode(&json!({ "index": null, "chunks": [] }));
    };
    let chunks = list_semantic_chunk_payloads(
        &conn,
        &handle.root_dir,
        &index_id,
        &request.paths,
        limit,
        offset,
    )?;
    encode(&json!({ "index": index, "chunks": chunks }))
}

pub(super) fn search_knowledge_index_json(
    handle: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: SearchSemanticIndexRequest = decode(&request)?;
    let index_id = request
        .index_id
        .unwrap_or_else(|| default_knowledge_index_id().to_string());
    let limit = request.limit.unwrap_or(20).clamp(1, 100) as usize;
    let conn = handle
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let Some(index) = read_knowledge_index_payload(&conn, &handle.root_dir, &index_id)? else {
        return encode(&json!({ "index": null, "results": [] }));
    };
    let dimensions = json_object_field(&index, "provider")
        .and_then(|provider| json_int_field(provider, "dimensions"))?;
    if let Some(vector) = request.vector.as_ref() {
        if vector.len() != dimensions as usize {
            return Err(napi_error(
                "invalid-engine-payload",
                &format!(
                    "Semantic search vector dimension mismatch: expected {dimensions}, got {}.",
                    vector.len()
                ),
            ));
        }
    }

    let candidate_limit = limit.saturating_mul(4).max(limit);
    let mut scores: HashMap<String, (Option<f32>, Option<f32>)> = HashMap::new();
    if let Some(vector) = request.vector.as_ref() {
        let vector_dir = semantic_vector_dir(&handle.state_path, &index_id);
        if vector_dir.exists() {
            let vector_db = EmbeddingDb::open(&vector_dir).map_err(vector_error)?;
            let matches = if request.paths.is_empty() {
                vector_db.search(vector, candidate_limit)
            } else {
                let allowed_ids = semantic_chunk_ids_for_paths(
                    &conn,
                    &handle.root_dir,
                    &index_id,
                    &request.paths,
                )?;
                vector_db.search_filtered(vector, candidate_limit, &allowed_ids)
            };
            for item in matches {
                scores.entry(item.id).or_default().0 = Some(item.score);
            }
        }
    }
    if let Some(query) = request.query.as_deref() {
        let lexical = semantic_lexical_matches(
            &conn,
            &handle.root_dir,
            &index_id,
            query,
            candidate_limit.saturating_mul(2),
        )?;
        for (rank, (id, _rank_score)) in lexical.into_iter().enumerate() {
            let score = 1.0_f32 / (rank as f32 + 1.0);
            scores.entry(id).or_default().1 = Some(score);
        }
    }

    let allowed_paths = request.paths.iter().cloned().collect::<HashSet<_>>();
    let mut ranked = Vec::new();
    for (id, (vector_score, lexical_score)) in scores {
        if let Some(chunk) = read_semantic_chunk_payload(&conn, &handle.root_dir, &index_id, &id)? {
            if !allowed_paths.is_empty() {
                let Some(path) = chunk.get("path").and_then(Value::as_str) else {
                    continue;
                };
                if !allowed_paths.contains(path) {
                    continue;
                }
            }
            let combined = match (vector_score, lexical_score) {
                (Some(vector), Some(lexical)) => (vector * 0.7) + (lexical * 0.3),
                (Some(vector), None) => vector * 0.95,
                (None, Some(lexical)) => lexical * 0.85,
                (None, None) => 0.0,
            };
            let mut score_parts = serde_json::Map::new();
            if let Some(score) = vector_score {
                score_parts.insert("vector".to_string(), json!(score));
            }
            if let Some(score) = lexical_score {
                score_parts.insert("lexical".to_string(), json!(score));
            }
            score_parts.insert("combined".to_string(), json!(combined));
            ranked.push((
                combined,
                json!({ "chunk": chunk, "score": combined, "scores": Value::Object(score_parts) }),
            ));
        }
    }
    ranked.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let results = ranked
        .into_iter()
        .take(limit)
        .map(|(_, result)| result)
        .collect::<Vec<_>>();
    encode(&json!({ "index": index, "results": results }))
}

pub(super) fn embed_semantic_texts_json(
    handle: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: EmbedSemanticTextsRequest = decode(&request)?;
    let model_id = request.model_id.trim();
    if model_id.is_empty() {
        return Err(napi_error(
            "invalid-engine-payload",
            "Semantic embedding model id is required.",
        ));
    }
    if request.texts.is_empty() {
        return Err(napi_error(
            "invalid-engine-payload",
            "Semantic embedding request must include at least one text.",
        ));
    }
    if let Some(index) = request.texts.iter().position(|text| text.trim().is_empty()) {
        return Err(napi_error(
            "invalid-engine-payload",
            &format!("Semantic embedding text at index {index} is empty."),
        ));
    }
    if request.task != "document" && request.task != "query" {
        return Err(napi_error(
            "invalid-engine-payload",
            "Semantic embedding task must be document or query.",
        ));
    }

    let embedder = handle.semantic_embedder(&request)?;
    let text_refs = request.texts.iter().map(String::as_str).collect::<Vec<_>>();
    let vectors = match request.task.as_str() {
        "document" => embedder.embed_batch(&text_refs),
        "query" => embedder.embed_query_batch(&text_refs),
        _ => unreachable!("semantic embedding task was validated before model loading"),
    }
    .map_err(inference_error)?;

    encode(&json!({
      "modelId": embedder.model_id(),
      "dimensions": embedder.dimensions(),
      "vectors": vectors,
    }))
}

pub(super) fn generate_text_json(
    handle: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: GenerateTextRequest = decode(&request)?;
    let model_id = request.model_id.trim();
    if model_id.is_empty() {
        return Err(napi_error(
            "invalid-engine-payload",
            "Generation model id is required.",
        ));
    }
    if request.prompt.trim().is_empty() {
        return Err(napi_error(
            "invalid-engine-payload",
            "Generation prompt is required.",
        ));
    }
    let options = generation_options(&request)?;
    let generator = handle.generator(&request)?;
    let text = generator
        .generate(&request.prompt, Some(options))
        .map_err(inference_error)?;

    encode(&json!({
      "modelId": generator.model_id(),
      "text": text,
    }))
}
