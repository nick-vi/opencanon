//! OpenCanon internal vector storage with HNSW index support.
//!
//! Provides mmap-backed vector storage with SIMD-accelerated similarity search
//! for project-local semantic indexes.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────┐
//! │           EmbeddingDb (storage API)      │
//! ├─────────────────────────────────────────┤
//! │  ┌──────────┐  ┌──────────┐  ┌────────┐ │
//! │  │  HNSW    │  │  Vector  │  │ ID Map │ │
//! │  │  Index   │  │  Store   │  │        │ │
//! │  └──────────┘  └──────────┘  └────────┘ │
//! ├─────────────────────────────────────────┤
//! │  SIMD: AVX2 / NEON / Scalar             │
//! └─────────────────────────────────────────┘
//! ```
//!
//! # Example
//!
//! ```ignore
//! use opencanon_vector::{EmbeddingDb, Config};
//! use std::path::Path;
//!
//! let config = Config::default();
//! let mut db = EmbeddingDb::create(Path::new("./data"), config)?;
//!
//! // Insert vectors
//! db.insert("doc1", &[0.1, 0.2, 0.3, ...])?;
//! db.insert("doc2", &[0.4, 0.5, 0.6, ...])?;
//!
//! // Search
//! let results = db.search(&query_vector, 10);
//! for result in results {
//!     println!("ID: {}, Score: {}", result.id, result.score);
//! }
//! ```

pub mod hnsw;
pub mod quantize;
pub mod quantized_search;
pub mod simd;
pub mod store;
#[cfg(feature = "wal")]
pub mod wal;

mod compaction;
mod types;

// Re-exports
pub use compaction::CompactionHandle;
pub use hnsw::{HnswConfig, HnswIndex};
pub use quantize::{QuantizationHeader, ScalarQuantizer, QUANTIZATION_MAGIC, QUANTIZATION_VERSION};
pub use quantized_search::{
    approximate_cosine_from_int8, quantized_similarity, QuantizedSearchEngine,
};
pub use simd::dot_int8;
pub use store::{IdMapData, MmapVectorStore, QuantizedVectorStore};
pub use types::{
    CompactionResult, Config, EmbedDbError, Match, Metrics, QuantizationConfig, Result,
    SearchResult,
};
#[cfg(feature = "wal")]
pub use wal::{RecordType, SyncMode, Wal, WalConfig, WalError, WalRecord, WalRecoveryIterator};

use parking_lot::RwLock;
use roaring::RoaringBitmap;
use std::collections::HashMap;
use std::path::Path;

/// Main embedding database
pub struct EmbeddingDb {
    path: std::path::PathBuf,
    store: MmapVectorStore,
    index: RwLock<HnswIndex>,
    id_map: RwLock<HashMap<String, usize>>,
    reverse_id_map: RwLock<HashMap<usize, String>>,
    deleted: RwLock<RoaringBitmap>,
    config: Config,
    /// Optional WAL for crash recovery (None if WAL disabled)
    #[cfg(feature = "wal")]
    wal: Option<wal::Wal>,
}

impl EmbeddingDb {
    /// Create a new embedding database at the given path
    pub fn create(path: &Path, config: Config) -> Result<Self> {
        let store = MmapVectorStore::open(path, config.dimensions)?;
        let hnsw_config = HnswConfig::new(config.m, config.ef_construction, config.ef_search);
        let index = HnswIndex::new(hnsw_config);

        // Initialize WAL if enabled
        #[cfg(feature = "wal")]
        let wal = if config.wal_enabled {
            let wal_config = wal::WalConfig {
                dir: path.join("wal"),
                sync_mode: config.wal_sync_mode,
                ..wal::WalConfig::new(path.join("wal"))
            };
            Some(wal::Wal::open(wal_config)?)
        } else {
            None
        };

        Ok(Self {
            path: path.to_path_buf(),
            store,
            index: RwLock::new(index),
            id_map: RwLock::new(HashMap::new()),
            reverse_id_map: RwLock::new(HashMap::new()),
            deleted: RwLock::new(RoaringBitmap::new()),
            config,
            #[cfg(feature = "wal")]
            wal,
        })
    }

    /// Open an existing embedding database
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_with_config(path, None)
    }

    /// Open an existing embedding database with custom config
    ///
    /// If `config` is None, defaults are used for WAL settings.
    pub fn open_with_config(path: &Path, config: Option<Config>) -> Result<Self> {
        // Recover from any interrupted compaction
        Self::recover_compaction(path)?;

        // Open store to read dimensions
        let store = MmapVectorStore::open(path, 384)?; // Initial guess
        let dimensions = store.dimensions();

        // Load HNSW index from disk (includes config)
        let index = HnswIndex::load(path)?;

        // Build config from loaded index (or use provided config)
        let hnsw_config = index.config();
        let mut db_config = config.unwrap_or_else(|| Config {
            dimensions,
            m: hnsw_config.m,
            ef_construction: hnsw_config.ef_construction,
            ef_search: hnsw_config.ef_search,
            ..Config::default()
        });
        // Ensure dimensions match stored data
        db_config.dimensions = dimensions;

        // Load ID map from disk
        let id_map_data = IdMapData::load(path)?;

        // Initialize WAL if enabled
        #[cfg(feature = "wal")]
        let wal = if db_config.wal_enabled {
            let wal_config = wal::WalConfig {
                dir: path.join("wal"),
                sync_mode: db_config.wal_sync_mode,
                ..wal::WalConfig::new(path.join("wal"))
            };
            Some(wal::Wal::open(wal_config)?)
        } else {
            None
        };

        let mut db = Self {
            path: path.to_path_buf(),
            store,
            index: RwLock::new(index),
            id_map: RwLock::new(id_map_data.id_map),
            reverse_id_map: RwLock::new(id_map_data.reverse_map),
            deleted: RwLock::new(id_map_data.deleted),
            config: db_config,
            #[cfg(feature = "wal")]
            wal,
        };

        // Replay WAL if enabled
        #[cfg(feature = "wal")]
        if db.wal.is_some() {
            db.replay_wal()?;
        }

        Ok(db)
    }

    /// Insert a vector with the given string ID
    pub fn insert(&mut self, id: &str, vector: &[f32]) -> Result<()> {
        if vector.len() != self.config.dimensions {
            return Err(EmbedDbError::DimensionMismatch {
                expected: self.config.dimensions,
                got: vector.len(),
            });
        }

        // Check for duplicate
        {
            let id_map = self.id_map.read();
            if id_map.contains_key(id) {
                return Err(EmbedDbError::DuplicateId(id.to_string()));
            }
        }

        // Append to store
        let internal_id = self.store.append(vector)?;

        // Write to WAL BEFORE updating in-memory state
        #[cfg(feature = "wal")]
        if let Some(ref wal) = self.wal {
            let record = wal::WalRecord::new_insert(id.to_string(), internal_id, vector.to_vec());
            wal.append(record)?;
        }

        // Update id maps
        {
            let mut id_map = self.id_map.write();
            let mut reverse = self.reverse_id_map.write();
            id_map.insert(id.to_string(), internal_id);
            reverse.insert(internal_id, id.to_string());
        }

        // Insert into HNSW index
        {
            let mut index = self.index.write();
            index.insert(internal_id, vector, &self.store);
        }

        Ok(())
    }

    /// Batch insert multiple vectors
    ///
    /// This is more efficient than calling `insert` multiple times because it:
    /// 1. Pre-allocates storage space for all vectors at once (single mmap)
    /// 2. Reduces lock contention
    ///
    /// All IDs must be unique and not already exist in the database.
    /// If any ID is a duplicate, the entire batch is rejected.
    pub fn insert_batch(&mut self, ids: &[String], vectors: &[Vec<f32>]) -> Result<()> {
        if ids.len() != vectors.len() {
            return Err(EmbedDbError::Corrupted(format!(
                "batch insert: ids length ({}) != vectors length ({})",
                ids.len(),
                vectors.len()
            )));
        }

        if ids.is_empty() {
            return Ok(());
        }

        // Validate all dimensions
        for vector in vectors.iter() {
            if vector.len() != self.config.dimensions {
                return Err(EmbedDbError::DimensionMismatch {
                    expected: self.config.dimensions,
                    got: vector.len(),
                });
            }
        }

        // Check for duplicates (both internal and within the batch)
        {
            let id_map = self.id_map.read();
            let mut seen = std::collections::HashSet::new();
            for id in ids {
                if id_map.contains_key(id) {
                    return Err(EmbedDbError::DuplicateId(id.clone()));
                }
                if !seen.insert(id) {
                    return Err(EmbedDbError::DuplicateId(format!(
                        "{} (duplicate within batch)",
                        id
                    )));
                }
            }
        }

        // Batch append all vectors to store (single mmap operation)
        let start_idx = self.store.append_batch(vectors)?;

        // Write to WAL BEFORE updating in-memory state
        #[cfg(feature = "wal")]
        if let Some(ref wal) = self.wal {
            let record = wal::WalRecord::new_batch_insert(
                ids.to_vec(),
                start_idx,
                vectors.iter().flat_map(|v| v.iter().copied()).collect(),
                self.config.dimensions,
            );
            wal.append(record)?;
        }

        // Update id maps
        {
            let mut id_map = self.id_map.write();
            let mut reverse = self.reverse_id_map.write();
            for (i, id) in ids.iter().enumerate() {
                let internal_id = start_idx + i;
                id_map.insert(id.clone(), internal_id);
                reverse.insert(internal_id, id.clone());
            }
        }

        // Insert all into HNSW index
        {
            let mut index = self.index.write();
            for (i, vector) in vectors.iter().enumerate() {
                let internal_id = start_idx + i;
                index.insert(internal_id, vector, &self.store);
            }
        }

        Ok(())
    }

    /// Search for the k nearest neighbors
    pub fn search(&self, vector: &[f32], k: usize) -> Vec<SearchResult> {
        let index = self.index.read();
        let deleted = self.deleted.read();
        let reverse = self.reverse_id_map.read();

        let matches = index.search(vector, k, self.config.ef_search, &self.store, &deleted);

        matches
            .into_iter()
            .filter_map(|m| {
                reverse.get(&m.id).map(|id| SearchResult {
                    id: id.clone(),
                    score: m.score,
                })
            })
            .collect()
    }

    /// Search with a filter on allowed IDs
    pub fn search_filtered(
        &self,
        vector: &[f32],
        k: usize,
        allowed_ids: &[String],
    ) -> Vec<SearchResult> {
        let index = self.index.read();
        let id_map = self.id_map.read();
        let reverse = self.reverse_id_map.read();

        // Convert string IDs to internal IDs
        let internal_ids: Vec<usize> = allowed_ids
            .iter()
            .filter_map(|id| id_map.get(id).copied())
            .collect();

        let matches =
            index.search_filtered(vector, k, self.config.ef_search, &self.store, &internal_ids);

        matches
            .into_iter()
            .filter_map(|m| {
                reverse.get(&m.id).map(|id| SearchResult {
                    id: id.clone(),
                    score: m.score,
                })
            })
            .collect()
    }

    /// Mark a vector as deleted (soft delete)
    ///
    /// **BREAKING CHANGE**: This method now returns `Result<bool>` instead of `bool`
    /// to support WAL error handling. Returns `Ok(true)` if deleted, `Ok(false)` if
    /// the ID was not found, or `Err` if WAL write failed.
    pub fn delete(&mut self, id: &str) -> Result<bool> {
        // Check if ID exists first
        let internal_id = {
            let id_map = self.id_map.read();
            match id_map.get(id) {
                Some(&id) => id,
                None => return Ok(false),
            }
        };

        // Write to WAL BEFORE updating in-memory state
        #[cfg(feature = "wal")]
        if let Some(ref wal) = self.wal {
            let record = wal::WalRecord::new_delete(id.to_string(), internal_id);
            wal.append(record)?;
        }

        // Apply delete to in-memory structures
        {
            let mut id_map = self.id_map.write();
            let mut reverse = self.reverse_id_map.write();
            let mut deleted = self.deleted.write();

            id_map.remove(id);
            reverse.remove(&internal_id);
            deleted.insert(internal_id as u32);
        }

        Ok(true)
    }

    /// Flush changes to disk
    ///
    /// This saves the vector store, HNSW index, and ID mappings.
    /// If WAL is enabled, also creates a checkpoint and truncates old WAL segments.
    pub fn flush(&self) -> Result<()> {
        // Get current LSN before flush (for checkpoint)
        #[cfg(feature = "wal")]
        let current_lsn = self.wal.as_ref().map(|w| w.current_lsn()).unwrap_or(0);

        // Flush vector store
        self.store.flush()?;

        // Save HNSW index
        {
            let index = self.index.read();
            index.save(&self.path)?;
        }

        // Save ID map
        {
            let id_map = self.id_map.read();
            let reverse_map = self.reverse_id_map.read();
            let deleted = self.deleted.read();

            let data = IdMapData {
                id_map: id_map.clone(),
                reverse_map: reverse_map.clone(),
                deleted: deleted.clone(),
            };
            data.save(&self.path)?;
        }

        // Checkpoint WAL and truncate old segments
        #[cfg(feature = "wal")]
        if let Some(ref wal) = self.wal {
            let vector_count = self.id_map.read().len() as u64;
            wal.checkpoint(current_lsn, vector_count)?;
            wal.truncate()?;
        }

        Ok(())
    }

    /// Get database metrics
    pub fn metrics(&self) -> Metrics {
        let deleted = self.deleted.read();
        Metrics {
            vector_count: self.store.len() as u64,
            deleted_count: deleted.len(),
            memory_bytes: (self.store.len() * self.config.dimensions * 4) as u64,
        }
    }

    /// Get the number of active vectors (excluding deleted)
    pub fn len(&self) -> usize {
        self.id_map.read().len()
    }

    /// Check if the database is empty
    pub fn is_empty(&self) -> bool {
        self.id_map.read().is_empty()
    }

    /// Get the vector dimensions
    pub fn dimensions(&self) -> usize {
        self.config.dimensions
    }

    /// Get a vector by its string ID
    pub fn get(&self, id: &str) -> Option<Vec<f32>> {
        let id_map = self.id_map.read();
        let internal_id = id_map.get(id)?;
        self.store.get(*internal_id).map(|v| v.to_vec())
    }

    /// Check if an ID exists
    pub fn contains(&self, id: &str) -> bool {
        self.id_map.read().contains_key(id)
    }

    /// Replay WAL records to recover state after crash
    #[cfg(feature = "wal")]
    fn replay_wal(&mut self) -> Result<()> {
        let wal = match &self.wal {
            Some(w) => w,
            None => return Ok(()),
        };

        let checkpoint_lsn = wal.checkpoint_lsn();
        let recovery_iter = wal::WalRecoveryIterator::new(wal.dir(), checkpoint_lsn)?;

        let mut replayed_count = 0u64;

        for record_result in recovery_iter {
            let record = record_result?;

            match record.record_type {
                wal::RecordType::Insert {
                    external_id,
                    internal_id: _, // We use sequential append, so original ID doesn't matter
                    vector,
                } => {
                    // Skip if already exists (idempotent replay)
                    if self.id_map.read().contains_key(&external_id) {
                        continue;
                    }

                    // Check dimensions
                    if vector.len() != self.config.dimensions {
                        continue; // Skip malformed records
                    }

                    // Append to store
                    let new_internal_id = self.store.append(&vector)?;

                    // Update mappings
                    {
                        let mut id_map = self.id_map.write();
                        let mut reverse = self.reverse_id_map.write();
                        id_map.insert(external_id.clone(), new_internal_id);
                        reverse.insert(new_internal_id, external_id);
                    }

                    // Update HNSW index
                    {
                        let mut index = self.index.write();
                        index.insert(new_internal_id, &vector, &self.store);
                    }

                    replayed_count += 1;
                }

                wal::RecordType::Delete {
                    external_id,
                    internal_id: _,
                } => {
                    // Look up internal ID from current mappings
                    let internal_id = {
                        let id_map = self.id_map.read();
                        match id_map.get(&external_id) {
                            Some(&id) => id,
                            None => continue, // Already deleted or never existed
                        }
                    };

                    // Apply delete
                    {
                        let mut id_map = self.id_map.write();
                        let mut reverse = self.reverse_id_map.write();
                        let mut deleted = self.deleted.write();

                        id_map.remove(&external_id);
                        reverse.remove(&internal_id);
                        deleted.insert(internal_id as u32);
                    }

                    replayed_count += 1;
                }

                wal::RecordType::BatchInsert {
                    external_ids,
                    start_internal_id: _,
                    vectors_flat,
                    dimensions,
                } => {
                    // Reconstruct vectors from flattened data
                    if dimensions != self.config.dimensions {
                        continue; // Skip malformed records
                    }

                    let vectors: Vec<Vec<f32>> = vectors_flat
                        .chunks(dimensions)
                        .map(|chunk| chunk.to_vec())
                        .collect();

                    if vectors.len() != external_ids.len() {
                        continue; // Skip malformed records
                    }

                    // Filter out already-existing entries
                    let new_items: Vec<_> = external_ids
                        .iter()
                        .zip(vectors.iter())
                        .filter(|(id, _)| !self.id_map.read().contains_key(*id))
                        .collect();

                    if new_items.is_empty() {
                        continue;
                    }

                    // Batch append new vectors
                    let new_vectors: Vec<Vec<f32>> =
                        new_items.iter().map(|(_, v)| (*v).clone()).collect();
                    let start_idx = self.store.append_batch(&new_vectors)?;

                    // Update mappings and index
                    {
                        let mut id_map = self.id_map.write();
                        let mut reverse = self.reverse_id_map.write();
                        let mut index = self.index.write();

                        for (i, (ext_id, vector)) in new_items.iter().enumerate() {
                            let internal_id = start_idx + i;
                            id_map.insert((*ext_id).clone(), internal_id);
                            reverse.insert(internal_id, (*ext_id).clone());
                            index.insert(internal_id, vector, &self.store);
                        }
                    }

                    replayed_count += new_items.len() as u64;
                }

                wal::RecordType::Checkpoint { .. } => {
                    // Checkpoint records are informational during recovery
                }
            }
        }

        if replayed_count > 0 {
            // Flush recovered state to disk
            self.flush()?;
        }

        Ok(())
    }

    // ==================== HNSW Graph Inspection Methods ====================

    /// Get the maximum level in the HNSW graph
    pub fn hnsw_max_level(&self) -> usize {
        self.index.read().max_level()
    }

    /// Get the total number of nodes in the HNSW graph
    pub fn hnsw_node_count(&self) -> usize {
        self.index.read().node_count()
    }

    /// Get the entry point node ID
    pub fn hnsw_entry_point(&self) -> Option<usize> {
        self.index.read().entry_point()
    }

    /// Get neighbors of a node at a specific level
    pub fn hnsw_neighbors(&self, id: usize, level: usize) -> Vec<usize> {
        self.index
            .read()
            .neighbors(id, level)
            .map(|n| n.to_vec())
            .unwrap_or_default()
    }

    /// Get the level of a specific node
    pub fn hnsw_node_level(&self, id: usize) -> Option<usize> {
        self.index.read().node_level(id)
    }

    /// Get count of nodes at each level
    pub fn hnsw_level_counts(&self) -> Vec<usize> {
        let index = self.index.read();
        let max_level = index.max_level();
        let mut counts = vec![0usize; max_level + 1];

        for node_id in 0..index.node_count() {
            if let Some(level) = index.node_level(node_id) {
                // A node at level L exists in levels 0..=L
                for count in counts.iter_mut().take(level.min(max_level) + 1) {
                    *count += 1;
                }
            }
        }
        counts
    }

    /// Get a sample of graph nodes for visualization
    /// Returns (node_id, level, neighbors_at_level_0)
    pub fn hnsw_sample_graph(&self, limit: usize) -> Vec<(usize, usize, Vec<usize>)> {
        let index = self.index.read();
        let mut result = Vec::with_capacity(limit);

        // Start from entry point and do BFS
        let entry = match index.entry_point() {
            Some(ep) => ep,
            None => return result,
        };

        let mut visited = std::collections::HashSet::new();
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(entry);
        visited.insert(entry);

        while let Some(node_id) = queue.pop_front() {
            if result.len() >= limit {
                break;
            }

            let level = index.node_level(node_id).unwrap_or(0);
            let neighbors = index
                .neighbors(node_id, 0)
                .map(|n| n.to_vec())
                .unwrap_or_default();

            result.push((node_id, level, neighbors.clone()));

            // Add unvisited neighbors to queue
            for &neighbor in &neighbors {
                if visited.insert(neighbor) {
                    queue.push_back(neighbor);
                }
            }
        }

        result
    }

    /// Search with trace - returns both results and the path taken through the graph
    /// Trace format: (node_id, level, distance)
    pub fn search_with_trace(
        &self,
        vector: &[f32],
        k: usize,
    ) -> (Vec<SearchResult>, Vec<(usize, usize, f32)>) {
        let index = self.index.read();
        let deleted = self.deleted.read();
        let reverse = self.reverse_id_map.read();

        let (matches, trace) = hnsw::search_with_trace(
            &index,
            vector,
            k,
            self.config.ef_search,
            &self.store,
            &deleted,
        );

        let results = matches
            .into_iter()
            .filter_map(|m| {
                reverse.get(&m.id).map(|id| SearchResult {
                    id: id.clone(),
                    score: m.score,
                })
            })
            .collect();

        (results, trace)
    }
}

#[cfg(test)]
mod tests;
