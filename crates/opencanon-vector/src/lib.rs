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

// Re-exports
pub use hnsw::{HnswConfig, HnswIndex};
pub use quantize::{QuantizationHeader, ScalarQuantizer, QUANTIZATION_MAGIC, QUANTIZATION_VERSION};
pub use quantized_search::{
    approximate_cosine_from_int8, quantized_similarity, QuantizedSearchEngine,
};
pub use simd::dot_int8;
pub use store::{IdMapData, MmapVectorStore, QuantizedVectorStore};
#[cfg(feature = "wal")]
pub use wal::{RecordType, SyncMode, Wal, WalConfig, WalError, WalRecord, WalRecoveryIterator};

use parking_lot::RwLock;
use roaring::RoaringBitmap;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use thiserror::Error;

/// Errors that can occur in EmbedDB operations
#[derive(Error, Debug)]
pub enum EmbedDbError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Vector not found: {0}")]
    NotFound(String),

    #[error("Dimension mismatch: expected {expected}, got {got}")]
    DimensionMismatch { expected: usize, got: usize },

    #[error("Database corrupted: {0}")]
    Corrupted(String),

    #[error("ID already exists: {0}")]
    DuplicateId(String),

    #[error("Insufficient disk space: need {required} bytes, available {available} bytes")]
    InsufficientSpace { required: u64, available: u64 },

    #[error("Compaction already in progress")]
    CompactionInProgress,
}

/// Result type for EmbedDB operations
pub type Result<T> = std::result::Result<T, EmbedDbError>;

/// Quantization configuration for memory-efficient vector storage
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum QuantizationConfig {
    /// No quantization - store vectors as f32 (default)
    #[default]
    None,
    /// Scalar quantization (f32 -> i8) with rescore factor for accuracy
    Scalar {
        /// How many extra candidates to fetch before rescoring with full precision
        rescore_factor: usize,
    },
}

impl QuantizationConfig {
    /// Create scalar quantization config with default rescore factor (4x)
    pub fn scalar() -> Self {
        Self::Scalar { rescore_factor: 4 }
    }

    /// Create scalar quantization config with custom rescore factor
    pub fn scalar_with_rescore(rescore_factor: usize) -> Self {
        Self::Scalar { rescore_factor }
    }

    /// Check if quantization is enabled
    pub fn is_enabled(&self) -> bool {
        !matches!(self, Self::None)
    }

    /// Get the rescore factor (1 if no quantization)
    pub fn rescore_factor(&self) -> usize {
        match self {
            Self::None => 1,
            Self::Scalar { rescore_factor } => *rescore_factor,
        }
    }
}

/// Configuration for the embedding database
#[derive(Debug, Clone)]
pub struct Config {
    /// Vector dimensions (e.g., 384 for nomic-embed-text)
    pub dimensions: usize,
    /// HNSW M parameter - connections per node (default: 16)
    pub m: usize,
    /// HNSW ef_construction - build quality (default: 200)
    pub ef_construction: usize,
    /// HNSW ef_search - search quality (default: 50)
    pub ef_search: usize,
    /// Quantization mode for memory-efficient storage (default: None)
    pub quantization: QuantizationConfig,
    /// Enable Write-Ahead Log for crash recovery (default: true with wal feature)
    pub wal_enabled: bool,
    /// WAL sync mode (default: EveryBatch)
    #[cfg(feature = "wal")]
    pub wal_sync_mode: wal::SyncMode,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            dimensions: 384,
            m: 16,
            ef_construction: 200,
            ef_search: 50,
            quantization: QuantizationConfig::None,
            #[cfg(feature = "wal")]
            wal_enabled: true,
            #[cfg(not(feature = "wal"))]
            wal_enabled: false,
            #[cfg(feature = "wal")]
            wal_sync_mode: wal::SyncMode::EveryBatch,
        }
    }
}

impl Config {
    /// Create a new config with custom dimensions
    pub fn with_dimensions(dimensions: usize) -> Self {
        Self {
            dimensions,
            ..Default::default()
        }
    }

    /// Create a new config with quantization enabled
    pub fn with_quantization(dimensions: usize, quantization: QuantizationConfig) -> Self {
        Self {
            dimensions,
            quantization,
            ..Default::default()
        }
    }

    /// Disable WAL for this configuration
    pub fn without_wal(mut self) -> Self {
        self.wal_enabled = false;
        self
    }
}

/// Search result with ID and similarity score
#[derive(Debug, Clone)]
pub struct Match {
    /// Internal vector ID
    pub id: usize,
    /// Cosine similarity score (0.0 to 1.0)
    pub score: f32,
}

/// Search result with external string ID
#[derive(Debug, Clone)]
pub struct SearchResult {
    /// External string ID
    pub id: String,
    /// Cosine similarity score (0.0 to 1.0)
    pub score: f32,
}

/// Database metrics for monitoring
#[derive(Debug, Clone, Default)]
pub struct Metrics {
    /// Total number of vectors (including deleted)
    pub vector_count: u64,
    /// Number of deleted vectors
    pub deleted_count: u64,
    /// Approximate memory usage in bytes
    pub memory_bytes: u64,
}

/// Result of a compaction operation
#[derive(Debug, Clone)]
pub struct CompactionResult {
    /// Number of deleted vectors removed
    pub vectors_removed: usize,
    /// Number of active vectors kept
    pub vectors_kept: usize,
    /// Bytes reclaimed from disk
    pub bytes_reclaimed: u64,
    /// Time taken in milliseconds
    pub duration_ms: u64,
}

/// Internal state shared between CompactionHandle and the background thread
struct CompactionState {
    /// Whether compaction is complete
    complete: AtomicBool,
    /// Progress from 0 to 100 (percentage * 100)
    progress: AtomicU64,
    /// Total vectors to process
    total: AtomicU64,
    /// Vectors processed so far
    processed: AtomicU64,
    /// Result of the compaction (set when complete)
    result: RwLock<Option<Result<CompactionResult>>>,
}

impl CompactionState {
    fn new(total: u64) -> Self {
        Self {
            complete: AtomicBool::new(false),
            progress: AtomicU64::new(0),
            total: AtomicU64::new(total),
            processed: AtomicU64::new(0),
            result: RwLock::new(None),
        }
    }

    fn update_progress(&self, processed: u64) {
        self.processed.store(processed, Ordering::Relaxed);
        let total = self.total.load(Ordering::Relaxed);
        if let Some(progress) = (processed * 100).checked_div(total) {
            self.progress.store(progress, Ordering::Relaxed);
        }
    }

    fn set_complete(&self, result: Result<CompactionResult>) {
        *self.result.write() = Some(result);
        self.progress.store(100, Ordering::Release);
        self.complete.store(true, Ordering::Release);
    }
}

/// Handle for tracking async compaction progress
pub struct CompactionHandle {
    state: Arc<CompactionState>,
    thread_handle: Option<std::thread::JoinHandle<()>>,
}

impl CompactionHandle {
    /// Check if compaction is complete
    pub fn is_complete(&self) -> bool {
        self.state.complete.load(Ordering::Acquire)
    }

    /// Get progress (0.0 to 1.0)
    pub fn progress(&self) -> f64 {
        self.state.progress.load(Ordering::Relaxed) as f64 / 100.0
    }

    /// Wait for compaction to complete and return the result
    pub fn wait(mut self) -> Result<CompactionResult> {
        // Wait for the thread to finish
        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }

        // Get the result
        let result = self.state.result.write().take();
        result.unwrap_or(Err(EmbedDbError::Corrupted(
            "Compaction thread completed without result".to_string(),
        )))
    }
}

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

    /// Compact the database, reclaiming disk space from deleted vectors
    ///
    /// This performs a full rebuild:
    /// 1. Creates new files in a temporary directory
    /// 2. Copies all non-deleted vectors with new contiguous indices
    /// 3. Rebuilds the HNSW index from scratch
    /// 4. Atomically swaps old files for new ones
    /// 5. Cleans up old files
    ///
    /// Returns a `CompactionResult` with statistics about the operation.
    ///
    /// # Safety
    ///
    /// This operation is crash-safe. If interrupted:
    /// - Old data remains intact
    /// - Incomplete compaction is detected and cleaned up on next open
    ///
    /// # Example
    /// ```ignore
    /// if db.should_compact() {
    ///     let result = db.compact()?;
    ///     println!("Compacted: removed {} vectors, kept {}",
    ///         result.vectors_removed, result.vectors_kept);
    /// }
    /// ```
    pub fn compact(&mut self) -> Result<CompactionResult> {
        // Force checkpoint before compaction to ensure all WAL records are persisted
        self.flush()?;

        let deleted = self.deleted.read();
        let deleted_count = deleted.len() as usize;
        let total_count = self.store.len();
        let active_count = total_count - deleted_count;

        // Nothing to compact
        if deleted_count == 0 {
            return Ok(CompactionResult {
                vectors_removed: 0,
                vectors_kept: active_count,
                bytes_reclaimed: 0,
                duration_ms: 0,
            });
        }

        drop(deleted);

        // Check disk space before starting
        self.check_disk_space_for_compaction()?;

        let start = std::time::Instant::now();

        // Calculate space that will be reclaimed
        let bytes_per_vector = self.config.dimensions * 4;
        let bytes_reclaimed = deleted_count * bytes_per_vector;

        // Create temp directory for new files
        let temp_path = self.path.join(".compact_temp");
        if temp_path.exists() {
            std::fs::remove_dir_all(&temp_path)?;
        }
        std::fs::create_dir_all(&temp_path)?;

        // Create new vector store
        let mut new_store = MmapVectorStore::open(&temp_path, self.config.dimensions)?;

        // Create new HNSW index
        let hnsw_config = HnswConfig::new(
            self.config.m,
            self.config.ef_construction,
            self.config.ef_search,
        );
        let mut new_index = HnswIndex::new(hnsw_config);

        // Build mappings: old internal ID → new internal ID
        let mut new_id_map: HashMap<String, usize> = HashMap::with_capacity(active_count);
        let mut new_reverse_map: HashMap<usize, String> = HashMap::with_capacity(active_count);

        // Copy non-deleted vectors
        {
            let deleted = self.deleted.read();
            let reverse_map = self.reverse_id_map.read();

            for old_internal_id in 0..total_count {
                // Skip deleted vectors
                if deleted.contains(old_internal_id as u32) {
                    continue;
                }

                // Get the vector
                let vector = match self.store.get(old_internal_id) {
                    Some(v) => v,
                    None => continue,
                };

                // Get the external ID
                let external_id = match reverse_map.get(&old_internal_id) {
                    Some(id) => id.clone(),
                    None => continue,
                };

                // Append to new store (gets new internal ID)
                let new_internal_id = new_store.append(vector)?;

                // Update mappings
                new_id_map.insert(external_id.clone(), new_internal_id);
                new_reverse_map.insert(new_internal_id, external_id);

                // Insert into new HNSW index
                new_index.insert(new_internal_id, vector, &new_store);
            }
        }

        // Save new index and id map to temp directory
        new_store.flush()?;
        new_index.save(&temp_path)?;

        let new_id_map_data = IdMapData {
            id_map: new_id_map.clone(),
            reverse_map: new_reverse_map.clone(),
            deleted: RoaringBitmap::new(),
        };
        new_id_map_data.save(&temp_path)?;

        // Atomic swap: rename old files to backup, then temp to main
        let backup_path = self.path.join(".compact_backup");
        if backup_path.exists() {
            std::fs::remove_dir_all(&backup_path)?;
        }

        // Move current files to backup
        self.move_db_files(&self.path, &backup_path)?;

        // Move new files to main path
        self.move_db_files(&temp_path, &self.path)?;

        // Clean up temp and backup directories
        if temp_path.exists() {
            std::fs::remove_dir_all(&temp_path)?;
        }
        if backup_path.exists() {
            std::fs::remove_dir_all(&backup_path)?;
        }

        // Reload the database with new data
        self.store = MmapVectorStore::open(&self.path, self.config.dimensions)?;
        *self.index.write() = new_index;
        *self.id_map.write() = new_id_map;
        *self.reverse_id_map.write() = new_reverse_map;
        self.deleted.write().clear();

        let duration_ms = start.elapsed().as_millis() as u64;

        // Checkpoint after compaction (all prior records are now in compacted files)
        // This ensures WAL is truncated and ready for new operations
        self.flush()?;

        Ok(CompactionResult {
            vectors_removed: deleted_count,
            vectors_kept: active_count,
            bytes_reclaimed: bytes_reclaimed as u64,
            duration_ms,
        })
    }

    /// Check if compaction is recommended
    ///
    /// Returns true if:
    /// - At least 20% of vectors are deleted, AND
    /// - At least 100 vectors are deleted (to avoid compacting tiny databases)
    pub fn should_compact(&self) -> bool {
        let deleted = self.deleted.read();
        let deleted_count = deleted.len() as usize;
        let total_count = self.store.len();

        if total_count == 0 {
            return false;
        }

        let deleted_ratio = deleted_count as f64 / total_count as f64;
        deleted_ratio >= 0.2 && deleted_count >= 100
    }

    /// Remove edges pointing to deleted nodes from HNSW graph
    ///
    /// This is a lightweight operation that improves search quality
    /// without the cost of full compaction. Does NOT reclaim disk space.
    ///
    /// Returns the number of edges removed.
    pub fn cleanup_edges(&mut self) -> Result<usize> {
        let deleted = self.deleted.read();
        let mut index = self.index.write();
        let edges_removed = index.cleanup_deleted_edges(&deleted);
        Ok(edges_removed)
    }

    /// Check if there's enough disk space for compaction
    ///
    /// Compaction uses copy-then-swap, so it needs approximately 2x the current
    /// database size during the operation.
    fn check_disk_space_for_compaction(&self) -> Result<()> {
        // Calculate current database size
        let vectors_file = self.path.join("vectors.bin");
        let hnsw_file = self.path.join("hnsw.db");
        let idmap_file = self.path.join("idmap.db");

        let mut current_size: u64 = 0;

        if vectors_file.exists() {
            current_size += std::fs::metadata(&vectors_file)?.len();
        }
        if hnsw_file.exists() {
            current_size += std::fs::metadata(&hnsw_file)?.len();
        }
        if idmap_file.exists() {
            current_size += std::fs::metadata(&idmap_file)?.len();
        }

        // We need approximately the same space for the new files, plus some buffer
        let required = current_size + (current_size / 10); // 10% buffer

        // Get available space on the filesystem
        #[cfg(unix)]
        let available = {
            // Use statvfs to get available space
            unsafe {
                let mut stat: libc::statvfs = std::mem::zeroed();
                let path_cstr =
                    std::ffi::CString::new(self.path.to_string_lossy().as_bytes()).unwrap();
                if libc::statvfs(path_cstr.as_ptr(), &mut stat) == 0 {
                    stat.f_bavail as u64 * stat.f_bsize
                } else {
                    // If statvfs fails, assume we have enough space
                    // (better to try and fail than to refuse)
                    u64::MAX
                }
            }
        };

        #[cfg(windows)]
        let available = {
            // On Windows, use GetDiskFreeSpaceExW
            // For now, assume we have enough space
            u64::MAX
        };

        #[cfg(not(any(unix, windows)))]
        let available = u64::MAX;

        if available < required {
            return Err(EmbedDbError::InsufficientSpace {
                required,
                available,
            });
        }

        Ok(())
    }

    /// Start compaction in background, allowing concurrent reads
    ///
    /// Returns a handle that can be used to check progress or wait for completion.
    /// Writes are blocked during compaction (due to the copy-then-swap nature).
    /// Reads continue using the old data until the swap completes.
    ///
    /// # Example
    /// ```ignore
    /// let handle = db.compact_async()?;
    /// while !handle.is_complete() {
    ///     println!("Progress: {:.0}%", handle.progress() * 100.0);
    ///     std::thread::sleep(std::time::Duration::from_millis(100));
    /// }
    /// let result = handle.wait()?;
    /// ```
    pub fn compact_async(db: Arc<RwLock<EmbeddingDb>>) -> Result<CompactionHandle> {
        // Get initial state from the database
        let (_path, config, deleted_count, _total_count, active_count) = {
            let db_read = db.read();
            let deleted = db_read.deleted.read();
            let deleted_count = deleted.len() as usize;
            let total_count = db_read.store.len();
            let active_count = total_count - deleted_count;
            (
                db_read.path.clone(),
                db_read.config.clone(),
                deleted_count,
                total_count,
                active_count,
            )
        };

        // Nothing to compact
        if deleted_count == 0 {
            let state = Arc::new(CompactionState::new(0));
            state.set_complete(Ok(CompactionResult {
                vectors_removed: 0,
                vectors_kept: active_count,
                bytes_reclaimed: 0,
                duration_ms: 0,
            }));
            return Ok(CompactionHandle {
                state,
                thread_handle: None,
            });
        }

        // Check disk space before starting
        {
            let db_read = db.read();
            db_read.check_disk_space_for_compaction()?;
        }

        // Create shared state for progress tracking
        let state = Arc::new(CompactionState::new(active_count as u64));
        let state_clone = Arc::clone(&state);
        let db_clone = Arc::clone(&db);

        let thread_handle = std::thread::spawn(move || {
            let result = Self::do_compact_async(db_clone, state_clone.clone(), config.clone());
            state_clone.set_complete(result);
        });

        Ok(CompactionHandle {
            state,
            thread_handle: Some(thread_handle),
        })
    }

    /// Internal implementation of async compaction
    fn do_compact_async(
        db: Arc<RwLock<EmbeddingDb>>,
        state: Arc<CompactionState>,
        config: Config,
    ) -> Result<CompactionResult> {
        let start = std::time::Instant::now();

        // Read data we need from the database (minimize lock time)
        let (path, deleted_clone, reverse_map_clone, total_count, active_count) = {
            let db_read = db.read();
            let deleted = db_read.deleted.read().clone();
            let reverse_map = db_read.reverse_id_map.read().clone();
            let total_count = db_read.store.len();
            let deleted_count = deleted.len() as usize;
            (
                db_read.path.clone(),
                deleted,
                reverse_map,
                total_count,
                total_count - deleted_count,
            )
        };

        let deleted_count = total_count - active_count;
        let bytes_per_vector = config.dimensions * 4;
        let bytes_reclaimed = deleted_count * bytes_per_vector;

        // Create temp directory for new files
        let temp_path = path.join(".compact_temp");
        if temp_path.exists() {
            std::fs::remove_dir_all(&temp_path)?;
        }
        std::fs::create_dir_all(&temp_path)?;

        // Create new vector store
        let mut new_store = MmapVectorStore::open(&temp_path, config.dimensions)?;

        // Create new HNSW index
        let hnsw_config = HnswConfig::new(config.m, config.ef_construction, config.ef_search);
        let mut new_index = HnswIndex::new(hnsw_config);

        // Build mappings: old internal ID → new internal ID
        let mut new_id_map: HashMap<String, usize> = HashMap::with_capacity(active_count);
        let mut new_reverse_map: HashMap<usize, String> = HashMap::with_capacity(active_count);

        let mut processed: u64 = 0;

        // Copy non-deleted vectors (need read lock for vector access)
        for old_internal_id in 0..total_count {
            // Skip deleted vectors
            if deleted_clone.contains(old_internal_id as u32) {
                continue;
            }

            // Get the vector (need brief read lock)
            let vector = {
                let db_read = db.read();
                db_read.store.get(old_internal_id).map(|v| v.to_vec())
            };

            let vector = match vector {
                Some(v) => v,
                None => continue,
            };

            // Get the external ID
            let external_id = match reverse_map_clone.get(&old_internal_id) {
                Some(id) => id.clone(),
                None => continue,
            };

            // Append to new store
            let new_internal_id = new_store.append(&vector)?;

            // Update mappings
            new_id_map.insert(external_id.clone(), new_internal_id);
            new_reverse_map.insert(new_internal_id, external_id);

            // Insert into new HNSW index
            new_index.insert(new_internal_id, &vector, &new_store);

            // Update progress
            processed += 1;
            state.update_progress(processed);
        }

        // Save new index and id map to temp directory
        new_store.flush()?;
        new_index.save(&temp_path)?;

        let new_id_map_data = IdMapData {
            id_map: new_id_map.clone(),
            reverse_map: new_reverse_map.clone(),
            deleted: RoaringBitmap::new(),
        };
        new_id_map_data.save(&temp_path)?;

        // Now we need exclusive access to swap files
        let mut db_write = db.write();

        // Atomic swap: rename old files to backup, then temp to main
        let backup_path = path.join(".compact_backup");
        if backup_path.exists() {
            std::fs::remove_dir_all(&backup_path)?;
        }

        // Move current files to backup
        db_write.move_db_files(&path, &backup_path)?;

        // Move new files to main path
        db_write.move_db_files(&temp_path, &path)?;

        // Clean up temp and backup directories
        if temp_path.exists() {
            std::fs::remove_dir_all(&temp_path)?;
        }
        if backup_path.exists() {
            std::fs::remove_dir_all(&backup_path)?;
        }

        // Reload the database with new data
        db_write.store = MmapVectorStore::open(&path, config.dimensions)?;
        *db_write.index.write() = new_index;
        *db_write.id_map.write() = new_id_map;
        *db_write.reverse_id_map.write() = new_reverse_map;
        db_write.deleted.write().clear();

        let duration_ms = start.elapsed().as_millis() as u64;

        Ok(CompactionResult {
            vectors_removed: deleted_count,
            vectors_kept: active_count,
            bytes_reclaimed: bytes_reclaimed as u64,
            duration_ms,
        })
    }

    /// Move database files from one directory to another
    fn move_db_files(&self, from: &Path, to: &Path) -> Result<()> {
        std::fs::create_dir_all(to)?;

        let files = ["vectors.bin", "hnsw.db", "idmap.db"];
        for file in &files {
            let src = from.join(file);
            let dst = to.join(file);
            if src.exists() {
                std::fs::rename(&src, &dst)?;
            }
        }

        Ok(())
    }

    /// Recover from interrupted compaction
    ///
    /// Called automatically on open. Handles:
    /// - Incomplete compaction (temp dir exists): clean up temp
    /// - Interrupted swap (backup exists but no main files): restore backup
    pub fn recover_compaction(path: &Path) -> Result<()> {
        let temp_path = path.join(".compact_temp");
        let backup_path = path.join(".compact_backup");
        let vectors_path = path.join("vectors.bin");

        // Case 1: Backup exists but main files don't - interrupted during swap
        if backup_path.exists() && !vectors_path.exists() {
            // Restore from backup
            let files = ["vectors.bin", "hnsw.db", "idmap.db"];
            for file in &files {
                let src = backup_path.join(file);
                let dst = path.join(file);
                if src.exists() {
                    std::fs::rename(&src, &dst)?;
                }
            }
        }

        // Clean up any leftover temp/backup directories
        if temp_path.exists() {
            std::fs::remove_dir_all(&temp_path)?;
        }
        if backup_path.exists() {
            std::fs::remove_dir_all(&backup_path)?;
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
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_create_and_insert() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
        db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();

        assert_eq!(db.len(), 2);
        assert!(db.contains("doc1"));
        assert!(db.contains("doc2"));
        assert!(!db.contains("doc3"));
    }

    #[test]
    fn test_search() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
        db.insert("doc2", &[0.9, 0.1, 0.0, 0.0]).unwrap();
        db.insert("doc3", &[0.0, 1.0, 0.0, 0.0]).unwrap();

        let results = db.search(&[1.0, 0.0, 0.0, 0.0], 3);

        // Should find results (at least 1)
        assert!(!results.is_empty(), "Should find at least one result");
        // First result should be exact match
        assert_eq!(results[0].id, "doc1", "First result should be exact match");
        assert!(
            (results[0].score - 1.0).abs() < 0.01,
            "Exact match should have score ~1.0, got {}",
            results[0].score
        );
    }

    #[test]
    fn test_delete() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
        db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();

        assert!(db.delete("doc1").unwrap());
        assert!(!db.contains("doc1"));
        assert_eq!(db.len(), 1);

        // Search should not return deleted
        let results = db.search(&[1.0, 0.0, 0.0, 0.0], 10);
        assert!(!results.iter().any(|r| r.id == "doc1"));
    }

    #[test]
    fn test_duplicate_id() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
        let result = db.insert("doc1", &[0.0, 1.0, 0.0, 0.0]);

        assert!(matches!(result, Err(EmbedDbError::DuplicateId(_))));
    }

    #[test]
    fn test_dimension_mismatch() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        let result = db.insert("doc1", &[1.0, 0.0, 0.0]); // 3 instead of 4

        assert!(matches!(
            result,
            Err(EmbedDbError::DimensionMismatch { .. })
        ));
    }

    #[test]
    fn test_get() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        let vector = vec![1.0, 2.0, 3.0, 4.0];
        db.insert("doc1", &vector).unwrap();

        let retrieved = db.get("doc1").unwrap();
        assert_eq!(retrieved, vector);

        assert!(db.get("nonexistent").is_none());
    }

    #[test]
    fn test_persistence_roundtrip() {
        let dir = tempdir().unwrap();

        // Create and populate database
        {
            let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

            db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
            db.insert("doc2", &[0.9, 0.1, 0.0, 0.0]).unwrap();
            db.insert("doc3", &[0.0, 1.0, 0.0, 0.0]).unwrap();
            db.insert("doc4", &[0.0, 0.0, 1.0, 0.0]).unwrap();

            // Delete one
            assert!(db.delete("doc3").unwrap());

            // Flush to disk
            db.flush().unwrap();
        }

        // Reopen and verify
        {
            let db = EmbeddingDb::open(dir.path()).unwrap();

            // Check counts
            assert_eq!(db.len(), 3, "Should have 3 active vectors");

            // Check ID existence
            assert!(db.contains("doc1"));
            assert!(db.contains("doc2"));
            assert!(!db.contains("doc3"), "doc3 should be deleted");
            assert!(db.contains("doc4"));

            // Check vector retrieval
            let v1 = db.get("doc1").unwrap();
            assert_eq!(v1, vec![1.0, 0.0, 0.0, 0.0]);

            // Check search works
            let results = db.search(&[1.0, 0.0, 0.0, 0.0], 5);
            assert!(!results.is_empty(), "Should find results");
            assert_eq!(results[0].id, "doc1", "First result should be doc1");
            assert!(
                (results[0].score - 1.0).abs() < 0.01,
                "Should have score ~1.0"
            );

            // doc3 should not appear in results
            assert!(
                !results.iter().any(|r| r.id == "doc3"),
                "Deleted doc3 should not appear in results"
            );
        }
    }

    #[test]
    fn test_open_empty_directory() {
        let dir = tempdir().unwrap();

        // Open a directory with no existing database
        let db = EmbeddingDb::open(dir.path()).unwrap();

        // Should be empty
        assert_eq!(db.len(), 0);
        assert!(db.is_empty());
    }

    #[test]
    fn test_compact_empty() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        // Compact empty database
        let result = db.compact().unwrap();
        assert_eq!(result.vectors_removed, 0);
        assert_eq!(result.vectors_kept, 0);
    }

    #[test]
    fn test_compact_no_deletions() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
        db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();

        // Compact with no deletions
        let result = db.compact().unwrap();
        assert_eq!(result.vectors_removed, 0);
        assert_eq!(result.vectors_kept, 2);
    }

    #[test]
    fn test_compact_with_deletions() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        // Insert several vectors
        db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
        db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
        db.insert("doc3", &[0.0, 0.0, 1.0, 0.0]).unwrap();
        db.insert("doc4", &[0.0, 0.0, 0.0, 1.0]).unwrap();

        // Delete some
        assert!(db.delete("doc2").unwrap());
        assert!(db.delete("doc3").unwrap());

        // Verify state before compaction
        assert_eq!(db.len(), 2);
        let metrics = db.metrics();
        assert_eq!(metrics.vector_count, 4); // 4 in store
        assert_eq!(metrics.deleted_count, 2); // 2 deleted

        // Compact
        let result = db.compact().unwrap();
        assert_eq!(result.vectors_removed, 2);
        assert_eq!(result.vectors_kept, 2);
        assert_eq!(result.bytes_reclaimed, 2 * 4 * 4); // 2 vectors * 4 dims * 4 bytes

        // Verify state after compaction
        assert_eq!(db.len(), 2);
        let metrics = db.metrics();
        assert_eq!(metrics.vector_count, 2); // Only 2 in store now
        assert_eq!(metrics.deleted_count, 0); // No deletions

        // Verify remaining vectors are accessible
        assert!(db.contains("doc1"));
        assert!(!db.contains("doc2"));
        assert!(!db.contains("doc3"));
        assert!(db.contains("doc4"));

        let v1 = db.get("doc1").unwrap();
        assert_eq!(v1, vec![1.0, 0.0, 0.0, 0.0]);

        let v4 = db.get("doc4").unwrap();
        assert_eq!(v4, vec![0.0, 0.0, 0.0, 1.0]);

        // Search should still work
        let results = db.search(&[1.0, 0.0, 0.0, 0.0], 10);
        assert!(!results.is_empty());
        assert_eq!(results[0].id, "doc1");
    }

    #[test]
    fn test_compact_persistence() {
        let dir = tempdir().unwrap();

        // Create, populate, delete, compact, flush
        {
            let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

            db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
            db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
            db.insert("doc3", &[0.0, 0.0, 1.0, 0.0]).unwrap();

            db.delete("doc2").unwrap();
            db.compact().unwrap();
            db.flush().unwrap();
        }

        // Reopen and verify
        {
            let db = EmbeddingDb::open(dir.path()).unwrap();

            assert_eq!(db.len(), 2);
            assert!(db.contains("doc1"));
            assert!(!db.contains("doc2"));
            assert!(db.contains("doc3"));

            let metrics = db.metrics();
            assert_eq!(metrics.vector_count, 2);
            assert_eq!(metrics.deleted_count, 0);
        }
    }

    #[test]
    fn test_should_compact() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        // Empty database
        assert!(!db.should_compact());

        // Add some vectors but not enough for threshold
        for i in 0..50 {
            db.insert(&format!("doc{}", i), &[i as f32, 0.0, 0.0, 0.0])
                .unwrap();
        }
        assert!(!db.should_compact());

        // Delete less than 20%
        for i in 0..5 {
            db.delete(&format!("doc{}", i)).unwrap();
        }
        assert!(!db.should_compact()); // 5/50 = 10%, below threshold

        // Add more vectors to reach minimum count
        for i in 50..500 {
            db.insert(&format!("doc{}", i), &[i as f32, 0.0, 0.0, 0.0])
                .unwrap();
        }

        // Delete 20%+ to trigger threshold
        for i in 5..150 {
            db.delete(&format!("doc{}", i)).unwrap();
        }
        // Now we have 150 deleted out of 500 = 30%
        assert!(db.should_compact());
    }

    #[test]
    fn test_compact_recovery_temp_exists() {
        let dir = tempdir().unwrap();

        // Create a database
        {
            let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
            db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
            db.flush().unwrap();
        }

        // Simulate interrupted compaction by creating temp directory
        let temp_path = dir.path().join(".compact_temp");
        std::fs::create_dir_all(&temp_path).unwrap();
        std::fs::write(temp_path.join("vectors.bin"), b"garbage").unwrap();

        // Open should clean up temp and work normally
        let db = EmbeddingDb::open(dir.path()).unwrap();
        assert_eq!(db.len(), 1);
        assert!(db.contains("doc1"));

        // Temp directory should be cleaned up
        assert!(!temp_path.exists());
    }

    // ==================== Task 1: Edge Cleanup Tests ====================

    #[test]
    fn test_cleanup_edges_no_deletions() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
        db.insert("doc2", &[0.9, 0.1, 0.0, 0.0]).unwrap();
        db.insert("doc3", &[0.0, 1.0, 0.0, 0.0]).unwrap();

        // No deletions, should remove 0 edges
        let edges_removed = db.cleanup_edges().unwrap();
        assert_eq!(edges_removed, 0);

        // Search should still work
        let results = db.search(&[1.0, 0.0, 0.0, 0.0], 3);
        assert!(!results.is_empty());
    }

    #[test]
    fn test_cleanup_edges_with_deletions() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        // Insert several vectors so we get edges in HNSW
        db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
        db.insert("doc2", &[0.9, 0.1, 0.0, 0.0]).unwrap();
        db.insert("doc3", &[0.8, 0.2, 0.0, 0.0]).unwrap();
        db.insert("doc4", &[0.0, 1.0, 0.0, 0.0]).unwrap();
        db.insert("doc5", &[0.0, 0.9, 0.1, 0.0]).unwrap();

        // Delete some vectors
        db.delete("doc2").unwrap();
        db.delete("doc4").unwrap();

        // cleanup_edges should remove edges pointing to deleted nodes
        let _edges_removed = db.cleanup_edges().unwrap();
        // We can't predict exact count, just verify it succeeds

        // Search should still work and not return deleted vectors
        let results = db.search(&[1.0, 0.0, 0.0, 0.0], 10);
        assert!(!results.iter().any(|r| r.id == "doc2"));
        assert!(!results.iter().any(|r| r.id == "doc4"));

        // Active vectors should still be findable
        assert!(results.iter().any(|r| r.id == "doc1"));
    }

    #[test]
    fn test_cleanup_edges_empty_db() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        // Should not error on empty database
        let edges_removed = db.cleanup_edges().unwrap();
        assert_eq!(edges_removed, 0);
    }

    // ==================== Task 2: Disk Space Check Tests ====================

    #[test]
    fn test_disk_space_check_passes() {
        let dir = tempdir().unwrap();
        let db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        // Should not error - we have plenty of space for a tiny database
        let result = db.check_disk_space_for_compaction();
        assert!(result.is_ok());
    }

    #[test]
    fn test_insufficient_space_error() {
        // Test that the error type exists and formats correctly
        let err = EmbedDbError::InsufficientSpace {
            required: 1000,
            available: 500,
        };
        let msg = format!("{}", err);
        assert!(msg.contains("1000"));
        assert!(msg.contains("500"));
    }

    // ==================== Task 3: Async Compaction Tests ====================

    #[test]
    fn test_compact_async_empty() {
        let dir = tempdir().unwrap();
        let db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
        let db = Arc::new(RwLock::new(db));

        // Compact empty database
        let handle = EmbeddingDb::compact_async(db.clone()).unwrap();

        // Should complete immediately
        assert!(handle.is_complete());
        assert!((handle.progress() - 1.0).abs() < 0.01);

        let result = handle.wait().unwrap();
        assert_eq!(result.vectors_removed, 0);
        assert_eq!(result.vectors_kept, 0);
    }

    #[test]
    fn test_compact_async_no_deletions() {
        let dir = tempdir().unwrap();
        let db = Arc::new(RwLock::new(
            EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap(),
        ));

        // Insert vectors
        {
            let mut db_write = db.write();
            db_write.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
            db_write.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
        }

        // Compact with no deletions
        let handle = EmbeddingDb::compact_async(db.clone()).unwrap();
        let result = handle.wait().unwrap();

        assert_eq!(result.vectors_removed, 0);
        assert_eq!(result.vectors_kept, 2);
    }

    #[test]
    fn test_compact_async_with_deletions() {
        let dir = tempdir().unwrap();
        let db = Arc::new(RwLock::new(
            EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap(),
        ));

        // Insert and delete
        {
            let mut db_write = db.write();
            db_write.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
            db_write.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
            db_write.insert("doc3", &[0.0, 0.0, 1.0, 0.0]).unwrap();
            db_write.insert("doc4", &[0.0, 0.0, 0.0, 1.0]).unwrap();
            db_write.delete("doc2").unwrap();
            db_write.delete("doc3").unwrap();
        }

        // Start async compaction
        let handle = EmbeddingDb::compact_async(db.clone()).unwrap();

        // Wait for completion
        let result = handle.wait().unwrap();

        assert_eq!(result.vectors_removed, 2);
        assert_eq!(result.vectors_kept, 2);

        // Verify database state after compaction
        {
            let db_read = db.read();
            assert_eq!(db_read.len(), 2);
            assert!(db_read.contains("doc1"));
            assert!(!db_read.contains("doc2"));
            assert!(!db_read.contains("doc3"));
            assert!(db_read.contains("doc4"));
        }
    }

    #[test]
    fn test_compact_async_progress() {
        let dir = tempdir().unwrap();
        let db = Arc::new(RwLock::new(
            EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap(),
        ));

        // Insert more vectors for observable progress
        {
            let mut db_write = db.write();
            for i in 0..20 {
                db_write
                    .insert(&format!("doc{}", i), &[i as f32, 0.0, 0.0, 0.0])
                    .unwrap();
            }
            // Delete some
            for i in 0..5 {
                db_write.delete(&format!("doc{}", i)).unwrap();
            }
        }

        let handle = EmbeddingDb::compact_async(db.clone()).unwrap();

        // Progress should be between 0 and 1
        let progress = handle.progress();
        assert!((0.0..=1.0).contains(&progress));

        // Wait and verify
        let result = handle.wait().unwrap();
        assert_eq!(result.vectors_removed, 5);
        assert_eq!(result.vectors_kept, 15);
    }

    #[test]
    fn test_compact_async_reads_during_compaction() {
        let dir = tempdir().unwrap();
        let db = Arc::new(RwLock::new(
            EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap(),
        ));

        // Insert vectors
        {
            let mut db_write = db.write();
            for i in 0..10 {
                db_write
                    .insert(&format!("doc{}", i), &[i as f32, 0.0, 0.0, 0.0])
                    .unwrap();
            }
            for i in 0..3 {
                db_write.delete(&format!("doc{}", i)).unwrap();
            }
        }

        // Start compaction
        let handle = EmbeddingDb::compact_async(db.clone()).unwrap();

        // While compaction is running, we should still be able to read
        // (though the data might be stale until swap completes)
        {
            let db_read = db.read();
            // Just verify we can access the database
            let _len = db_read.len();
        }

        // Wait for completion
        let result = handle.wait().unwrap();
        assert_eq!(result.vectors_removed, 3);
        assert_eq!(result.vectors_kept, 7);

        // Verify final state
        {
            let db_read = db.read();
            assert_eq!(db_read.len(), 7);
        }
    }

    // ==================== Batch Insert Tests ====================

    #[test]
    fn test_batch_insert() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        let ids = vec!["doc1".to_string(), "doc2".to_string(), "doc3".to_string()];
        let vectors = vec![
            vec![1.0, 0.0, 0.0, 0.0],
            vec![0.0, 1.0, 0.0, 0.0],
            vec![0.0, 0.0, 1.0, 0.0],
        ];

        db.insert_batch(&ids, &vectors).unwrap();

        assert_eq!(db.len(), 3);
        assert!(db.contains("doc1"));
        assert!(db.contains("doc2"));
        assert!(db.contains("doc3"));

        // Verify vectors are retrievable
        assert_eq!(db.get("doc1").unwrap(), vec![1.0, 0.0, 0.0, 0.0]);
        assert_eq!(db.get("doc2").unwrap(), vec![0.0, 1.0, 0.0, 0.0]);
        assert_eq!(db.get("doc3").unwrap(), vec![0.0, 0.0, 1.0, 0.0]);
    }

    #[test]
    fn test_batch_insert_searchable() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        let ids = vec!["doc1".to_string(), "doc2".to_string(), "doc3".to_string()];
        let vectors = vec![
            vec![1.0, 0.0, 0.0, 0.0],
            vec![0.9, 0.1, 0.0, 0.0],
            vec![0.0, 1.0, 0.0, 0.0],
        ];

        db.insert_batch(&ids, &vectors).unwrap();

        // Search should work
        let results = db.search(&[1.0, 0.0, 0.0, 0.0], 3);
        assert!(!results.is_empty());
        assert_eq!(results[0].id, "doc1");
    }

    #[test]
    fn test_batch_insert_empty() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        db.insert_batch(&[], &[]).unwrap();
        assert_eq!(db.len(), 0);
    }

    #[test]
    fn test_batch_insert_duplicate_existing() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        // Insert one first
        db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();

        // Try batch with duplicate
        let ids = vec!["doc1".to_string(), "doc2".to_string()];
        let vectors = vec![vec![0.0, 1.0, 0.0, 0.0], vec![0.0, 0.0, 1.0, 0.0]];

        let result = db.insert_batch(&ids, &vectors);
        assert!(matches!(result, Err(EmbedDbError::DuplicateId(_))));

        // Database should be unchanged
        assert_eq!(db.len(), 1);
    }

    #[test]
    fn test_batch_insert_duplicate_within_batch() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        let ids = vec![
            "doc1".to_string(),
            "doc2".to_string(),
            "doc1".to_string(), // Duplicate!
        ];
        let vectors = vec![
            vec![1.0, 0.0, 0.0, 0.0],
            vec![0.0, 1.0, 0.0, 0.0],
            vec![0.0, 0.0, 1.0, 0.0],
        ];

        let result = db.insert_batch(&ids, &vectors);
        assert!(matches!(result, Err(EmbedDbError::DuplicateId(_))));

        // Database should be unchanged
        assert_eq!(db.len(), 0);
    }

    #[test]
    fn test_batch_insert_dimension_mismatch() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        let ids = vec!["doc1".to_string(), "doc2".to_string()];
        let vectors = vec![
            vec![1.0, 0.0, 0.0, 0.0],
            vec![0.0, 1.0, 0.0], // Wrong dimension!
        ];

        let result = db.insert_batch(&ids, &vectors);
        assert!(matches!(
            result,
            Err(EmbedDbError::DimensionMismatch { .. })
        ));

        // Database should be unchanged
        assert_eq!(db.len(), 0);
    }

    #[test]
    fn test_batch_insert_length_mismatch() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        let ids = vec!["doc1".to_string(), "doc2".to_string()];
        let vectors = vec![vec![1.0, 0.0, 0.0, 0.0]]; // Only one vector!

        let result = db.insert_batch(&ids, &vectors);
        assert!(result.is_err());
    }

    #[test]
    fn test_batch_insert_mixed_with_single() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        // Single insert first
        db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();

        // Batch insert
        let ids = vec!["doc2".to_string(), "doc3".to_string()];
        let vectors = vec![vec![0.0, 1.0, 0.0, 0.0], vec![0.0, 0.0, 1.0, 0.0]];
        db.insert_batch(&ids, &vectors).unwrap();

        // Single insert after
        db.insert("doc4", &[0.0, 0.0, 0.0, 1.0]).unwrap();

        assert_eq!(db.len(), 4);

        // All should be searchable
        let results = db.search(&[1.0, 0.0, 0.0, 0.0], 4);
        assert_eq!(results.len(), 4);
    }

    #[test]
    fn test_batch_insert_persistence() {
        let dir = tempdir().unwrap();

        // Create and batch insert
        {
            let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
            let ids = vec!["doc1".to_string(), "doc2".to_string()];
            let vectors = vec![vec![1.0, 0.0, 0.0, 0.0], vec![0.0, 1.0, 0.0, 0.0]];
            db.insert_batch(&ids, &vectors).unwrap();
            db.flush().unwrap();
        }

        // Reopen and verify
        {
            let db = EmbeddingDb::open(dir.path()).unwrap();
            assert_eq!(db.len(), 2);
            assert!(db.contains("doc1"));
            assert!(db.contains("doc2"));
            assert_eq!(db.get("doc1").unwrap(), vec![1.0, 0.0, 0.0, 0.0]);

            // Search should work
            let results = db.search(&[1.0, 0.0, 0.0, 0.0], 2);
            assert!(!results.is_empty());
        }
    }

    #[test]
    fn test_batch_insert_large() {
        let dir = tempdir().unwrap();
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        // Insert 100 vectors in a batch - use orthogonal vectors for reliable search
        let ids: Vec<String> = (0..100).map(|i| format!("doc{}", i)).collect();
        let vectors: Vec<Vec<f32>> = (0..100)
            .map(|i| {
                // Create more distinguishable vectors using different components
                let angle = (i as f32) * std::f32::consts::PI * 2.0 / 100.0;
                vec![angle.cos(), angle.sin(), 0.0, 0.0]
            })
            .collect();

        db.insert_batch(&ids, &vectors).unwrap();

        assert_eq!(db.len(), 100);

        // Spot check some vectors
        assert!(db.contains("doc0"));
        assert!(db.contains("doc50"));
        assert!(db.contains("doc99"));

        // Search should find a result (not testing exact match since HNSW is approximate)
        let results = db.search(&vectors[50], 5);
        assert!(!results.is_empty());
        // The exact match should be in top results
        assert!(
            results.iter().any(|r| r.id == "doc50"),
            "doc50 should be in search results, got: {:?}",
            results.iter().map(|r| &r.id).collect::<Vec<_>>()
        );
    }

    // ==================== WAL Integration Tests ====================

    #[cfg(feature = "wal")]
    mod wal_integration_tests {
        use super::*;
        use tempfile::tempdir;

        #[test]
        fn test_wal_crash_recovery_insert() {
            let dir = tempdir().unwrap();

            // Insert records but DON'T flush
            {
                let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
                db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
                db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
                db.insert("doc3", &[0.0, 0.0, 1.0, 0.0]).unwrap();
                // Simulate crash by dropping without flush
            }

            // Reopen - WAL should replay
            {
                let db = EmbeddingDb::open(dir.path()).unwrap();
                assert_eq!(db.len(), 3);
                assert!(db.contains("doc1"));
                assert!(db.contains("doc2"));
                assert!(db.contains("doc3"));
                assert_eq!(db.get("doc1").unwrap(), vec![1.0, 0.0, 0.0, 0.0]);
            }
        }

        #[test]
        fn test_wal_crash_recovery_batch_insert() {
            let dir = tempdir().unwrap();

            // Batch insert without flush
            {
                let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
                let ids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
                let vectors = vec![
                    vec![1.0, 0.0, 0.0, 0.0],
                    vec![0.0, 1.0, 0.0, 0.0],
                    vec![0.0, 0.0, 1.0, 0.0],
                ];
                db.insert_batch(&ids, &vectors).unwrap();
                // Crash without flush
            }

            // Reopen - WAL should replay batch
            {
                let db = EmbeddingDb::open(dir.path()).unwrap();
                assert_eq!(db.len(), 3);
                assert!(db.contains("a"));
                assert!(db.contains("b"));
                assert!(db.contains("c"));
            }
        }

        #[test]
        fn test_wal_crash_recovery_delete() {
            let dir = tempdir().unwrap();

            // Insert then delete without flush
            {
                let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
                db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
                db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
                db.delete("doc1").unwrap();
                // Crash without flush
            }

            // Reopen - WAL should replay insert and delete
            {
                let db = EmbeddingDb::open(dir.path()).unwrap();
                assert_eq!(db.len(), 1);
                assert!(!db.contains("doc1"), "doc1 should be deleted");
                assert!(db.contains("doc2"));
            }
        }

        #[test]
        fn test_wal_normal_operation_with_flush() {
            let dir = tempdir().unwrap();

            // Insert and flush
            {
                let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
                db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
                db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
                db.flush().unwrap();
            }

            // Reopen and verify
            {
                let db = EmbeddingDb::open(dir.path()).unwrap();
                assert_eq!(db.len(), 2);
                assert!(db.contains("doc1"));
                assert!(db.contains("doc2"));
            }

            // Add more data after reopen
            {
                let mut db = EmbeddingDb::open(dir.path()).unwrap();
                db.insert("doc3", &[0.0, 0.0, 1.0, 0.0]).unwrap();
                // Crash without flush
            }

            // Reopen - should have doc1, doc2 from checkpoint + doc3 from WAL
            {
                let db = EmbeddingDb::open(dir.path()).unwrap();
                assert_eq!(db.len(), 3);
                assert!(db.contains("doc1"));
                assert!(db.contains("doc2"));
                assert!(db.contains("doc3"));
            }
        }

        #[test]
        fn test_wal_checkpoint_truncates_wal() {
            let dir = tempdir().unwrap();

            {
                let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

                // Insert some records
                for i in 0..10 {
                    db.insert(&format!("doc{}", i), &[i as f32, 0.0, 0.0, 0.0])
                        .unwrap();
                }

                // Flush should checkpoint and truncate WAL
                db.flush().unwrap();
            }

            // Reopen and verify
            {
                let db = EmbeddingDb::open(dir.path()).unwrap();
                assert_eq!(db.len(), 10);
            }
        }

        #[test]
        fn test_wal_disabled() {
            let dir = tempdir().unwrap();

            // Create with WAL disabled
            {
                let config = Config::with_dimensions(4).without_wal();
                let mut db = EmbeddingDb::create(dir.path(), config).unwrap();
                db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
                // No flush - data will be lost
            }

            // Reopen - should be empty (no WAL to recover from, no flush)
            {
                let config = Config::with_dimensions(4).without_wal();
                let _db = EmbeddingDb::open_with_config(dir.path(), Some(config)).unwrap();
                // Data might or might not be there depending on mmap behavior
                // The important thing is no crash
            }
        }

        #[test]
        fn test_wal_idempotent_recovery() {
            let dir = tempdir().unwrap();

            // Insert records
            {
                let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
                db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
                db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
            }

            // Reopen multiple times - should be idempotent
            for _ in 0..3 {
                let db = EmbeddingDb::open(dir.path()).unwrap();
                assert_eq!(db.len(), 2);
                assert!(db.contains("doc1"));
                assert!(db.contains("doc2"));
            }
        }

        #[test]
        fn test_wal_compaction_coordination() {
            let dir = tempdir().unwrap();

            {
                let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

                // Insert and delete some vectors
                for i in 0..10 {
                    db.insert(&format!("doc{}", i), &[i as f32, 0.0, 0.0, 0.0])
                        .unwrap();
                }
                for i in 0..5 {
                    db.delete(&format!("doc{}", i)).unwrap();
                }

                // Compact should checkpoint before and after
                db.compact().unwrap();

                assert_eq!(db.len(), 5);
            }

            // Reopen and verify
            {
                let db = EmbeddingDb::open(dir.path()).unwrap();
                assert_eq!(db.len(), 5);
                for i in 5..10 {
                    assert!(db.contains(&format!("doc{}", i)));
                }
            }
        }

        #[test]
        fn test_wal_search_after_recovery() {
            let dir = tempdir().unwrap();

            // Insert without flush
            {
                let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
                db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
                db.insert("doc2", &[0.9, 0.1, 0.0, 0.0]).unwrap();
                db.insert("doc3", &[0.0, 1.0, 0.0, 0.0]).unwrap();
            }

            // Reopen and search
            {
                let db = EmbeddingDb::open(dir.path()).unwrap();
                let results = db.search(&[1.0, 0.0, 0.0, 0.0], 3);
                assert!(!results.is_empty());
                assert_eq!(results[0].id, "doc1");
            }
        }
    }
}
