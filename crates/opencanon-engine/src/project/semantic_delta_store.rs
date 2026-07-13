use opencanon_vector::{Config as VectorConfig, EmbeddingDb};
use rusqlite::params;
use serde_json::Value;

use crate::contracts::WriteSemanticIndexDeltaRequest;
use crate::json::{decode, napi_error, sqlite_error};
use crate::state::timestamp;

use super::semantic_store::{
    assert_semantic_chunk_count, delete_semantic_nodes, read_knowledge_index_payload,
    read_semantic_chunk_hashes, semantic_chunk_ids_for_paths, upsert_semantic_chunk_rows,
    upsert_semantic_nodes, validate_knowledge_index_delta_request, vector_error,
    write_semantic_vector_delta,
};
use super::semantic_vector_store::{
    begin_semantic_vector_delta_publication, lock_semantic_vectors_exclusive,
};
use super::EngineProjectHandle;

pub(super) fn write_knowledge_index_delta_json(
    handle: &EngineProjectHandle,
    request: String,
) -> napi::Result<()> {
    let request: WriteSemanticIndexDeltaRequest = decode(&request)?;
    validate_knowledge_index_delta_request(&request)?;

    let vector_lock = lock_semantic_vectors_exclusive(&handle.state_path, &request.index.id)?;
    let mut conn = handle
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let previous_index = read_knowledge_index_payload(&conn, &handle.root_dir, &request.index.id)?
        .ok_or_else(|| {
            napi_error(
                "invalid-engine-payload",
                "Semantic index does not exist. Run a full Project Knowledge rebuild before applying deltas.",
            )
        })?;
    let previous_identity = previous_index.get("identityHash").and_then(Value::as_str);
    if let Some(previous_identity) = previous_identity {
        if previous_identity != request.index.identity_hash {
            return Err(napi_error(
                "invalid-engine-payload",
                "Semantic index provider identity changed; run a full Project Knowledge rebuild before applying deltas.",
            ));
        }
    } else {
        return Err(napi_error(
            "invalid-engine-payload",
            "Semantic index identity is missing. Run a full Project Knowledge rebuild before applying deltas.",
        ));
    }

    let existing_chunks = read_semantic_chunk_hashes(&conn, &handle.root_dir, &request.index.id)?;
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

    let vector_config = VectorConfig::with_dimensions(request.index.provider.dimensions as usize);
    let mut removed_ids = semantic_chunk_ids_for_paths(
        &conn,
        &handle.root_dir,
        &request.index.id,
        &request.removed_paths,
    )?;
    removed_ids.sort();
    removed_ids.dedup();

    let publication = begin_semantic_vector_delta_publication(
        vector_lock,
        &handle.state_path,
        &request.index.id,
        &previous_index,
        &request.index,
    )?;
    let mut vector_db =
        EmbeddingDb::open_with_config(publication.vector_dir(), Some(vector_config.clone()))
            .map_err(vector_error)?;
    write_semantic_vector_delta(
        &mut vector_db,
        &existing_chunks,
        &removed_ids,
        &request.chunks,
    )
    .map_err(vector_error)?;
    drop(vector_db);
    publication.assert_vector_count()?;

    let indexed_at = request.index.indexed_at.clone();
    let diagnostics_json = serde_json::to_string(&request.index.diagnostics)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
    let index_payload = serde_json::to_string(&request.index)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;

    let tx = conn
        .transaction()
        .map_err(|error| sqlite_error("Could not start semantic index delta transaction", error))?;
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

    for path in request.removed_paths.iter() {
        tx.execute(
            "delete from knowledge_chunks_fts where root_dir = ?1 and index_id = ?2 and path = ?3",
            params![handle.root_dir, request.index.id, path],
        )
        .map_err(|error| {
            sqlite_error(
                "Could not delete semantic search text for removed path",
                error,
            )
        })?;
        tx.execute(
            "delete from knowledge_chunks where root_dir = ?1 and index_id = ?2 and path = ?3",
            params![handle.root_dir, request.index.id, path],
        )
        .map_err(|error| {
            sqlite_error("Could not delete semantic chunks for removed path", error)
        })?;
    }
    for chunk in request.chunks.iter() {
        tx.execute(
            "delete from knowledge_chunks_fts where root_dir = ?1 and index_id = ?2 and id = ?3",
            params![handle.root_dir, request.index.id, chunk.metadata.id],
        )
        .map_err(|error| sqlite_error("Could not replace semantic search text", error))?;
    }
    upsert_semantic_chunk_rows(
        &tx,
        &handle.root_dir,
        &request.index.id,
        &indexed_at,
        &request.chunks,
    )?;
    delete_semantic_nodes(
        &tx,
        &handle.root_dir,
        &request.index.id,
        &request.removed_paths,
        &request.removed_node_keys,
    )?;
    upsert_semantic_nodes(&tx, &handle.root_dir, &request.index.id, &request.nodes)?;
    assert_semantic_chunk_count(
        &tx,
        &handle.root_dir,
        &request.index.id,
        request.index.chunk_count,
    )?;
    tx.commit().map_err(|error| {
        sqlite_error("Could not commit semantic index delta transaction", error)
    })?;
    publication.commit()
}
