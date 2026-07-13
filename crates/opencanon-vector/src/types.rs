use thiserror::Error;

#[cfg(feature = "wal")]
use crate::wal;

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
