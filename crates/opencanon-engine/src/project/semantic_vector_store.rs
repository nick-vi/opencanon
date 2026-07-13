use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use opencanon_vector::{Config as VectorConfig, EmbeddingDb};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::contracts::{SemanticChunkEmbeddingRequest, SemanticIndexSnapshotRequest};
use crate::json::napi_error;

use super::semantic_store::vector_error;

const PUBLICATION_FORMAT_VERSION: u32 = 1;
const PUBLICATION_FILE: &str = "publication.json";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SemanticVectorPublicationMarker {
    format_version: u32,
    identity_hash: String,
    chunk_tree_hash: String,
    vector_count: u32,
    dimensions: u32,
}

struct SemanticVectorPaths {
    live: PathBuf,
    staging: PathBuf,
    backup: PathBuf,
    pending: PathBuf,
    lock: PathBuf,
}

pub(super) struct SemanticVectorLock {
    _file: File,
}

pub(super) struct FullSemanticVectorPublication {
    _lock: SemanticVectorLock,
    paths: SemanticVectorPaths,
    had_backup: bool,
}

pub(super) struct SemanticVectorDeltaPublication {
    _lock: SemanticVectorLock,
    paths: SemanticVectorPaths,
    target: SemanticVectorPublicationMarker,
}

pub(super) fn semantic_vector_dir(state_path: &str, index_id: &str) -> PathBuf {
    semantic_vector_parent(state_path).join(sanitize_state_segment(index_id))
}

pub(super) fn lock_semantic_vectors_shared(
    state_path: &str,
    index_id: &str,
) -> napi::Result<SemanticVectorLock> {
    lock_semantic_vectors(state_path, index_id, false)
}

pub(super) fn lock_semantic_vectors_exclusive(
    state_path: &str,
    index_id: &str,
) -> napi::Result<SemanticVectorLock> {
    lock_semantic_vectors(state_path, index_id, true)
}

pub(super) fn semantic_vector_publication_failure_locked(
    state_path: &str,
    index_id: &str,
    index: &Value,
) -> Option<String> {
    let paths = semantic_vector_paths(state_path, index_id);
    if paths.pending.exists() {
        return Some(
            "Semantic vector publication was interrupted before it became current.".to_string(),
        );
    }
    let expected = match marker_from_value(index) {
        Ok(marker) => marker,
        Err(message) => return Some(message),
    };
    let actual = match read_marker(&paths.live.join(PUBLICATION_FILE)) {
        Ok(marker) => marker,
        Err(message) => return Some(message),
    };
    if actual != expected {
        return Some(
            "Semantic vector publication identity does not match the Project Knowledge snapshot."
                .to_string(),
        );
    }
    if !paths.live.exists() {
        return Some("Semantic vector store is missing.".to_string());
    }
    match EmbeddingDb::open_with_config(
        &paths.live,
        Some(VectorConfig::with_dimensions(expected.dimensions as usize)),
    ) {
        Ok(db) if db.len() == expected.vector_count as usize => None,
        Ok(db) => Some(format!(
            "Semantic vector count mismatch: expected {}, got {}.",
            expected.vector_count,
            db.len()
        )),
        Err(error) => Some(format!("Semantic vector store is unreadable: {error}")),
    }
}

pub(super) fn prepare_full_semantic_vector_publication(
    state_path: &str,
    index: &SemanticIndexSnapshotRequest,
    chunks: &[SemanticChunkEmbeddingRequest],
) -> napi::Result<FullSemanticVectorPublication> {
    let lock = lock_semantic_vectors(state_path, &index.id, true)?;
    let paths = semantic_vector_paths(state_path, &index.id);
    remove_dir_if_exists(&paths.staging, "clear stale semantic vector staging")?;
    remove_dir_if_exists(&paths.backup, "clear stale semantic vector backup")?;

    let target = marker_from_snapshot(index);
    ensure_pending_marker(
        &paths.pending,
        &target,
        "write pending semantic publication",
    )?;
    fs::create_dir_all(&paths.staging)
        .map_err(|error| vector_state_error("create semantic vector staging", error))?;

    let config = VectorConfig::with_dimensions(index.provider.dimensions as usize);
    let mut db = EmbeddingDb::create(&paths.staging, config).map_err(vector_error)?;
    let ids = chunks
        .iter()
        .map(|chunk| chunk.metadata.id.clone())
        .collect::<Vec<_>>();
    let vectors = chunks
        .iter()
        .map(|chunk| chunk.vector.clone())
        .collect::<Vec<_>>();
    db.insert_batch(&ids, &vectors).map_err(vector_error)?;
    db.flush().map_err(vector_error)?;
    if db.len() != index.vector_count as usize {
        return Err(napi_error(
            "invalid-engine-payload",
            &format!(
                "Complete semantic vector publication expected {} vectors but wrote {}.",
                index.vector_count,
                db.len()
            ),
        ));
    }
    drop(db);
    write_marker_atomic(
        &paths.staging.join(PUBLICATION_FILE),
        &target,
        "write semantic publication identity",
    )?;

    let had_backup = paths.live.exists();
    if had_backup {
        fs::rename(&paths.live, &paths.backup)
            .map_err(|error| vector_state_error("move current semantic vector store", error))?;
    }
    if let Err(error) = fs::rename(&paths.staging, &paths.live) {
        if had_backup && !paths.live.exists() {
            let _ = fs::rename(&paths.backup, &paths.live);
        }
        return Err(vector_state_error(
            "publish complete semantic vector store",
            error,
        ));
    }

    Ok(FullSemanticVectorPublication {
        _lock: lock,
        paths,
        had_backup,
    })
}

impl FullSemanticVectorPublication {
    pub(super) fn commit(self) -> napi::Result<()> {
        remove_dir_if_exists(&self.paths.backup, "remove semantic vector backup")?;
        remove_file_if_exists(&self.paths.pending, "complete semantic vector publication")
    }

    pub(super) fn rollback(self, had_previous_index: bool) -> napi::Result<()> {
        remove_dir_if_exists(&self.paths.live, "remove unpublished semantic vector store")?;
        remove_dir_if_exists(&self.paths.staging, "remove semantic vector staging")?;
        if self.had_backup {
            fs::rename(&self.paths.backup, &self.paths.live).map_err(|error| {
                vector_state_error("restore previous semantic vector store", error)
            })?;
            remove_file_if_exists(
                &self.paths.pending,
                "clear rolled back semantic publication",
            )?;
        } else if !had_previous_index {
            remove_file_if_exists(&self.paths.pending, "clear unused semantic publication")?;
        }
        Ok(())
    }
}

pub(super) fn begin_semantic_vector_delta_publication(
    lock: SemanticVectorLock,
    state_path: &str,
    index_id: &str,
    previous_index: &Value,
    target_index: &SemanticIndexSnapshotRequest,
) -> napi::Result<SemanticVectorDeltaPublication> {
    if let Some(message) =
        semantic_vector_publication_failure_locked(state_path, index_id, previous_index)
    {
        return Err(napi_error(
            "invalid-engine-payload",
            &format!("{message} Run a full Project Knowledge rebuild before applying deltas."),
        ));
    }
    let paths = semantic_vector_paths(state_path, index_id);
    let target = marker_from_snapshot(target_index);
    ensure_pending_marker(&paths.pending, &target, "write pending semantic delta")?;
    Ok(SemanticVectorDeltaPublication {
        _lock: lock,
        paths,
        target,
    })
}

impl SemanticVectorDeltaPublication {
    pub(super) fn vector_dir(&self) -> &Path {
        &self.paths.live
    }

    pub(super) fn assert_vector_count(&self) -> napi::Result<()> {
        let db = EmbeddingDb::open_with_config(
            &self.paths.live,
            Some(VectorConfig::with_dimensions(
                self.target.dimensions as usize,
            )),
        )
        .map_err(vector_error)?;
        if db.len() != self.target.vector_count as usize {
            return Err(napi_error(
                "invalid-engine-payload",
                &format!(
                    "Semantic vector delta expected {} vectors but wrote {}. Run a full Project Knowledge rebuild.",
                    self.target.vector_count,
                    db.len()
                ),
            ));
        }
        Ok(())
    }

    pub(super) fn commit(self) -> napi::Result<()> {
        write_marker_atomic(
            &self.paths.live.join(PUBLICATION_FILE),
            &self.target,
            "publish semantic delta identity",
        )?;
        remove_file_if_exists(&self.paths.pending, "complete semantic delta publication")
    }
}

fn semantic_vector_parent(state_path: &str) -> PathBuf {
    Path::new(state_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("semantic-index")
}

fn semantic_vector_paths(state_path: &str, index_id: &str) -> SemanticVectorPaths {
    let parent = semantic_vector_parent(state_path);
    let segment = sanitize_state_segment(index_id);
    SemanticVectorPaths {
        live: parent.join(&segment),
        staging: parent.join(format!(".{segment}.staging")),
        backup: parent.join(format!(".{segment}.backup")),
        pending: parent.join(format!(".{segment}.pending.json")),
        lock: parent.join(format!(".{segment}.lock")),
    }
}

fn lock_semantic_vectors(
    state_path: &str,
    index_id: &str,
    exclusive: bool,
) -> napi::Result<SemanticVectorLock> {
    let paths = semantic_vector_paths(state_path, index_id);
    let parent = paths.lock.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|error| vector_state_error("create semantic vector state directory", error))?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&paths.lock)
        .map_err(|error| vector_state_error("open semantic vector publication lock", error))?;
    if exclusive {
        file.lock()
            .map_err(|error| vector_state_error("lock semantic vector publication", error))?;
    } else {
        file.lock_shared()
            .map_err(|error| vector_state_error("lock semantic vector reader", error))?;
    }
    Ok(SemanticVectorLock { _file: file })
}

fn marker_from_snapshot(index: &SemanticIndexSnapshotRequest) -> SemanticVectorPublicationMarker {
    SemanticVectorPublicationMarker {
        format_version: PUBLICATION_FORMAT_VERSION,
        identity_hash: index.identity_hash.clone(),
        chunk_tree_hash: index.chunk_tree_hash.clone(),
        vector_count: index.vector_count,
        dimensions: index.provider.dimensions,
    }
}

fn marker_from_value(index: &Value) -> Result<SemanticVectorPublicationMarker, String> {
    serde_json::from_value(serde_json::json!({
        "formatVersion": PUBLICATION_FORMAT_VERSION,
        "identityHash": required_string(index, "identityHash")?,
        "chunkTreeHash": required_string(index, "chunkTreeHash")?,
        "vectorCount": required_u32(index, "vectorCount")?,
        "dimensions": index
            .get("provider")
            .ok_or_else(|| "Semantic index metadata has no provider.".to_string())?
            .get("dimensions")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| "Semantic index metadata has invalid dimensions.".to_string())?,
    }))
    .map_err(|error| format!("Semantic index publication metadata is invalid: {error}"))
}

fn required_string(index: &Value, field: &str) -> Result<String, String> {
    index
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Semantic index metadata has invalid {field}."))
}

fn required_u32(index: &Value, field: &str) -> Result<u32, String> {
    index
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| format!("Semantic index metadata has invalid {field}."))
}

fn read_marker(path: &Path) -> Result<SemanticVectorPublicationMarker, String> {
    if !path.exists() {
        return Err("Semantic vector publication identity is missing.".to_string());
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Semantic vector publication identity is unreadable: {error}"))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Semantic vector publication identity is invalid: {error}"))
}

fn write_marker_atomic(
    path: &Path,
    marker: &SemanticVectorPublicationMarker,
    action: &str,
) -> napi::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| vector_state_error(action, error))?;
    let temporary = path.with_extension("tmp");
    remove_file_if_exists(&temporary, action)?;
    let contents = serde_json::to_vec(marker)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| vector_state_error(action, error))?;
    file.write_all(&contents)
        .map_err(|error| vector_state_error(action, error))?;
    file.sync_all()
        .map_err(|error| vector_state_error(action, error))?;
    drop(file);
    remove_file_if_exists(path, action)?;
    fs::rename(&temporary, path).map_err(|error| vector_state_error(action, error))
}

fn ensure_pending_marker(
    path: &Path,
    marker: &SemanticVectorPublicationMarker,
    action: &str,
) -> napi::Result<()> {
    if path.exists() {
        return Ok(());
    }
    write_marker_atomic(path, marker, action)
}

fn remove_dir_if_exists(path: &Path, action: &str) -> napi::Result<()> {
    if path.exists() {
        fs::remove_dir_all(path).map_err(|error| vector_state_error(action, error))?;
    }
    Ok(())
}

fn remove_file_if_exists(path: &Path, action: &str) -> napi::Result<()> {
    if path.exists() {
        fs::remove_file(path).map_err(|error| vector_state_error(action, error))?;
    }
    Ok(())
}

fn vector_state_error(action: &str, error: std::io::Error) -> napi::Error {
    napi_error(
        "invalid-engine-payload",
        &format!("Could not {action}: {error}"),
    )
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
        "project".to_string()
    } else {
        output
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn exclusive_publication_lock_blocks_readers_until_release() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "opencanon-semantic-publication-lock-{}-{unique}",
            std::process::id()
        ));
        let state_path = root.join(".opencanon/state/test/state.sqlite");
        let state_path = state_path.to_string_lossy().to_string();
        let exclusive = lock_semantic_vectors_exclusive(&state_path, "project").unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (acquired_tx, acquired_rx) = mpsc::channel();

        let reader = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let _shared = lock_semantic_vectors_shared(&state_path, "project").unwrap();
            acquired_tx.send(()).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(acquired_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err());
        drop(exclusive);
        acquired_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        reader.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
