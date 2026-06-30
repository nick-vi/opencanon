//! Write-Ahead Log (WAL) for crash recovery
//!
//! Provides durability guarantees for insert, delete, and batch operations
//! by logging changes before they are applied to the main data structures.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────┐    ┌─────────────┐    ┌──────────────┐
//! │  API Call   │───▶│  WAL Append │───▶│  Data Store  │
//! │             │    │  + Sync     │    │  + Index     │
//! └─────────────┘    └──────┬──────┘    └──────────────┘
//!                          │
//!                          ▼
//!                    ┌─────────┐
//!                    │  wal/   │  ◀── Sequential writes
//!                    │ segment │
//!                    └─────────┘
//! ```
//!
//! # File Format
//!
//! Each WAL segment file has the following structure:
//! - Header (32 bytes): magic, version, segment_id, timestamps, prev_lsn
//! - Records: length-prefixed MessagePack-serialized WalRecord with CRC32
//!
//! # Recovery
//!
//! On startup, the WAL is replayed from the last checkpoint LSN to recover
//! any operations that were not persisted to the main data files.

use crate::EmbedDbError;
use crc32fast::Hasher;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

// ============================================================================
// Constants
// ============================================================================

/// Magic number for WAL segment files: "EBDW" (EmbedDB WAL)
pub const WAL_MAGIC: u32 = 0x57444245;

/// Current WAL format version
pub const WAL_VERSION: u16 = 1;

/// Size of WAL segment header in bytes
pub const WAL_HEADER_SIZE: usize = 32;

/// Default maximum segment size (64MB)
pub const DEFAULT_MAX_SEGMENT_SIZE: u64 = 64 * 1024 * 1024;

/// Default checkpoint interval in operations
pub const DEFAULT_CHECKPOINT_INTERVAL_OPS: u64 = 10_000;

/// Filename prefix for WAL segment files
const WAL_SEGMENT_PREFIX: &str = "wal.";

/// Checkpoint metadata filename
const CHECKPOINT_FILENAME: &str = "checkpoint";

// ============================================================================
// Error Types
// ============================================================================

/// WAL-specific errors
#[derive(Debug, Clone, PartialEq)]
pub enum WalError {
    /// IO error during WAL operations
    Io(String),
    /// Invalid magic number in segment header
    InvalidMagic(u32),
    /// Unsupported WAL version
    UnsupportedVersion(u16),
    /// Checksum mismatch in WAL record
    ChecksumMismatch {
        lsn: u64,
        expected: u32,
        actual: u32,
    },
    /// Incomplete record at end of segment
    IncompleteRecord(u64),
    /// WAL segment not found
    SegmentNotFound(u64),
    /// Serialization/deserialization error
    Serialization(String),
    /// WAL is corrupted
    Corrupted(String),
}

impl std::fmt::Display for WalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WalError::Io(msg) => write!(f, "WAL IO error: {}", msg),
            WalError::InvalidMagic(magic) => {
                write!(
                    f,
                    "invalid WAL magic: expected 0x{:08X}, got 0x{:08X}",
                    WAL_MAGIC, magic
                )
            }
            WalError::UnsupportedVersion(v) => write!(f, "unsupported WAL version: {}", v),
            WalError::ChecksumMismatch {
                lsn,
                expected,
                actual,
            } => {
                write!(
                    f,
                    "checksum mismatch at LSN {}: expected 0x{:08X}, got 0x{:08X}",
                    lsn, expected, actual
                )
            }
            WalError::IncompleteRecord(offset) => {
                write!(f, "incomplete record at offset {}", offset)
            }
            WalError::SegmentNotFound(id) => write!(f, "WAL segment {} not found", id),
            WalError::Serialization(msg) => write!(f, "WAL serialization error: {}", msg),
            WalError::Corrupted(msg) => write!(f, "WAL corrupted: {}", msg),
        }
    }
}

impl std::error::Error for WalError {}

impl From<std::io::Error> for WalError {
    fn from(e: std::io::Error) -> Self {
        WalError::Io(e.to_string())
    }
}

impl From<WalError> for EmbedDbError {
    fn from(e: WalError) -> Self {
        EmbedDbError::Corrupted(e.to_string())
    }
}

// ============================================================================
// WAL Record Types
// ============================================================================

/// A single record in the Write-Ahead Log
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalRecord {
    /// Unique, monotonically increasing sequence number
    pub lsn: u64,
    /// Type of operation being logged
    pub record_type: RecordType,
    /// Unix timestamp in milliseconds
    pub timestamp: u64,
}

impl WalRecord {
    /// Create a new insert record
    pub fn new_insert(external_id: String, internal_id: usize, vector: Vec<f32>) -> Self {
        Self {
            lsn: 0, // Will be assigned by WAL
            record_type: RecordType::Insert {
                external_id,
                internal_id,
                vector,
            },
            timestamp: 0, // Will be assigned by WAL
        }
    }

    /// Create a new delete record
    pub fn new_delete(external_id: String, internal_id: usize) -> Self {
        Self {
            lsn: 0,
            record_type: RecordType::Delete {
                external_id,
                internal_id,
            },
            timestamp: 0,
        }
    }

    /// Create a new batch insert record
    pub fn new_batch_insert(
        external_ids: Vec<String>,
        start_internal_id: usize,
        vectors_flat: Vec<f32>,
        dimensions: usize,
    ) -> Self {
        Self {
            lsn: 0,
            record_type: RecordType::BatchInsert {
                external_ids,
                start_internal_id,
                vectors_flat,
                dimensions,
            },
            timestamp: 0,
        }
    }

    /// Create a checkpoint record
    pub fn new_checkpoint(last_flushed_lsn: u64, vector_count: u64) -> Self {
        Self {
            lsn: 0,
            record_type: RecordType::Checkpoint {
                last_flushed_lsn,
                vector_count,
            },
            timestamp: 0,
        }
    }

    /// Serialize the record to bytes (MessagePack format)
    pub fn serialize(&self) -> std::result::Result<Vec<u8>, WalError> {
        rmp_serde::to_vec(self).map_err(|e| WalError::Serialization(e.to_string()))
    }

    /// Deserialize a record from bytes
    pub fn deserialize(data: &[u8]) -> std::result::Result<Self, WalError> {
        rmp_serde::from_slice(data).map_err(|e| WalError::Serialization(e.to_string()))
    }
}

/// Types of operations that can be logged
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum RecordType {
    /// Single vector insertion
    Insert {
        /// External string ID
        external_id: String,
        /// Internal numeric ID assigned
        internal_id: usize,
        /// The vector data
        vector: Vec<f32>,
    },

    /// Soft delete of a vector
    Delete {
        /// External string ID being deleted
        external_id: String,
        /// Internal numeric ID
        internal_id: usize,
    },

    /// Batch insertion of multiple vectors
    BatchInsert {
        /// External string IDs
        external_ids: Vec<String>,
        /// Starting internal ID (for contiguous allocation)
        start_internal_id: usize,
        /// Vector data (flattened for efficiency)
        vectors_flat: Vec<f32>,
        /// Number of dimensions per vector
        dimensions: usize,
    },

    /// Checkpoint marker
    Checkpoint {
        /// LSN of last record included in checkpoint
        last_flushed_lsn: u64,
        /// Number of active vectors at checkpoint time
        vector_count: u64,
    },
}

// ============================================================================
// WAL Segment Header
// ============================================================================

/// WAL segment file header (32 bytes)
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct WalHeader {
    /// Magic number: "EBDW" = 0x57444245
    pub magic: u32,
    /// Format version (currently 1)
    pub version: u16,
    /// Padding for alignment
    pub _reserved1: u16,
    /// Segment sequence number
    pub segment_id: u64,
    /// Creation timestamp (Unix millis)
    pub created_at: u64,
    /// LSN of last record in previous segment
    pub prev_segment_lsn: u64,
}

impl WalHeader {
    /// Create a new header for a segment
    pub fn new(segment_id: u64, prev_lsn: u64) -> Self {
        Self {
            magic: WAL_MAGIC,
            version: WAL_VERSION,
            _reserved1: 0,
            segment_id,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
            prev_segment_lsn: prev_lsn,
        }
    }

    /// Validate the header
    pub fn validate(&self) -> std::result::Result<(), WalError> {
        if self.magic != WAL_MAGIC {
            return Err(WalError::InvalidMagic(self.magic));
        }
        if self.version > WAL_VERSION {
            return Err(WalError::UnsupportedVersion(self.version));
        }
        Ok(())
    }

    /// Serialize header to bytes
    pub fn to_bytes(&self) -> [u8; WAL_HEADER_SIZE] {
        let mut bytes = [0u8; WAL_HEADER_SIZE];
        bytes[0..4].copy_from_slice(&self.magic.to_le_bytes());
        bytes[4..6].copy_from_slice(&self.version.to_le_bytes());
        bytes[6..8].copy_from_slice(&self._reserved1.to_le_bytes());
        bytes[8..16].copy_from_slice(&self.segment_id.to_le_bytes());
        bytes[16..24].copy_from_slice(&self.created_at.to_le_bytes());
        bytes[24..32].copy_from_slice(&self.prev_segment_lsn.to_le_bytes());
        bytes
    }

    /// Deserialize header from bytes
    pub fn from_bytes(bytes: &[u8]) -> std::result::Result<Self, WalError> {
        if bytes.len() < WAL_HEADER_SIZE {
            return Err(WalError::Corrupted("header too short".into()));
        }
        Ok(Self {
            magic: u32::from_le_bytes(bytes[0..4].try_into().unwrap()),
            version: u16::from_le_bytes(bytes[4..6].try_into().unwrap()),
            _reserved1: u16::from_le_bytes(bytes[6..8].try_into().unwrap()),
            segment_id: u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
            created_at: u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
            prev_segment_lsn: u64::from_le_bytes(bytes[24..32].try_into().unwrap()),
        })
    }
}

// ============================================================================
// WAL Configuration
// ============================================================================

/// Synchronization mode for WAL writes
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SyncMode {
    /// No explicit sync - OS decides when to flush
    /// Fastest but may lose recent writes on crash
    None,

    /// fsync after every write
    /// Slowest but guarantees durability
    EveryWrite,

    /// fsync after each batch of writes
    /// Good balance for batch operations
    #[default]
    EveryBatch,
}

/// WAL configuration options
#[derive(Debug, Clone)]
pub struct WalConfig {
    /// Directory for WAL segment files
    pub dir: PathBuf,
    /// Maximum segment file size before rotation (default: 64MB)
    pub max_segment_size: u64,
    /// Sync mode for durability guarantees
    pub sync_mode: SyncMode,
    /// Checkpoint after this many operations
    pub checkpoint_interval_ops: u64,
}

impl WalConfig {
    /// Create a new config with the given directory
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            max_segment_size: DEFAULT_MAX_SEGMENT_SIZE,
            sync_mode: SyncMode::default(),
            checkpoint_interval_ops: DEFAULT_CHECKPOINT_INTERVAL_OPS,
        }
    }
}

// ============================================================================
// WAL Segment
// ============================================================================

/// A single WAL segment file
struct WalSegment {
    /// Segment ID
    id: u64,
    /// File handle with buffered writer
    writer: BufWriter<File>,
    /// Current file position (bytes written)
    position: u64,
    /// Path to segment file (kept for potential future use in debugging/metrics)
    #[allow(dead_code)]
    path: PathBuf,
}

impl WalSegment {
    /// Create a new segment file
    fn create(dir: &Path, id: u64, prev_lsn: u64) -> std::result::Result<Self, WalError> {
        let path = segment_path(dir, id);
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .read(true)
            .truncate(true)
            .open(&path)?;

        let mut writer = BufWriter::new(file);

        // Write header
        let header = WalHeader::new(id, prev_lsn);
        writer.write_all(&header.to_bytes())?;
        writer.flush()?;

        Ok(Self {
            id,
            writer,
            position: WAL_HEADER_SIZE as u64,
            path,
        })
    }

    /// Open an existing segment for appending
    fn open_for_append(dir: &Path, id: u64) -> std::result::Result<(Self, u64), WalError> {
        let path = segment_path(dir, id);
        let file = OpenOptions::new().read(true).write(true).open(&path)?;

        // Read and validate header
        let mut reader = BufReader::new(&file);
        let mut header_bytes = [0u8; WAL_HEADER_SIZE];
        reader.read_exact(&mut header_bytes)?;
        let header = WalHeader::from_bytes(&header_bytes)?;
        header.validate()?;

        // Find last LSN by scanning records
        let file_len = file.metadata()?.len();
        let mut position = WAL_HEADER_SIZE as u64;
        let mut last_lsn = header.prev_segment_lsn;

        while position < file_len {
            reader.seek(SeekFrom::Start(position))?;

            // Try to read record length
            let mut len_bytes = [0u8; 4];
            match reader.read_exact(&mut len_bytes) {
                Ok(_) => {}
                Err(_) => break, // Incomplete record at end
            }
            let record_len = u32::from_le_bytes(len_bytes) as u64;

            // Skip if record would exceed file
            if position + 4 + record_len + 4 > file_len {
                break;
            }

            // Read record data to get LSN
            let mut record_data = vec![0u8; record_len as usize];
            if reader.read_exact(&mut record_data).is_err() {
                break;
            }

            // Verify CRC
            let mut crc_bytes = [0u8; 4];
            if reader.read_exact(&mut crc_bytes).is_err() {
                break;
            }
            let stored_crc = u32::from_le_bytes(crc_bytes);
            let computed_crc = compute_crc(&record_data);
            if stored_crc != computed_crc {
                break; // Stop at first corrupted record
            }

            // Parse record to get LSN
            if let Ok(record) = WalRecord::deserialize(&record_data) {
                last_lsn = record.lsn;
            }

            position += 4 + record_len + 4;
        }

        // Reopen file for writing at end
        let file = OpenOptions::new().write(true).open(&path)?;
        file.set_len(position)?; // Truncate any incomplete record

        let mut writer = BufWriter::new(file);
        writer.seek(SeekFrom::Start(position))?;

        Ok((
            Self {
                id,
                writer,
                position,
                path,
            },
            last_lsn,
        ))
    }

    /// Write a record to the segment
    fn write_record(&mut self, data: &[u8]) -> std::result::Result<(), WalError> {
        // Write length prefix (4 bytes)
        let len = data.len() as u32;
        self.writer.write_all(&len.to_le_bytes())?;

        // Write record data
        self.writer.write_all(data)?;

        // Write CRC32 (4 bytes)
        let crc = compute_crc(data);
        self.writer.write_all(&crc.to_le_bytes())?;

        // Update position
        self.position += 4 + data.len() as u64 + 4;

        Ok(())
    }

    /// Sync the segment to disk
    fn sync(&mut self) -> std::result::Result<(), WalError> {
        self.writer.flush()?;
        self.writer.get_ref().sync_all()?;
        Ok(())
    }

    /// Get current segment size
    #[allow(dead_code)]
    fn size(&self) -> u64 {
        self.position
    }
}

// ============================================================================
// WAL Implementation
// ============================================================================

/// Write-Ahead Log for crash recovery
pub struct Wal {
    /// Configuration
    config: WalConfig,
    /// Current segment file
    current_segment: Mutex<WalSegment>,
    /// Current LSN (atomic for lock-free reads)
    current_lsn: AtomicU64,
    /// LSN of last successful fsync
    flushed_lsn: AtomicU64,
    /// LSN of last checkpoint
    checkpoint_lsn: AtomicU64,
    /// Operations since last checkpoint
    ops_since_checkpoint: AtomicU64,
}

impl Wal {
    /// Create a new WAL or open existing
    pub fn open(config: WalConfig) -> std::result::Result<Self, WalError> {
        std::fs::create_dir_all(&config.dir)?;

        // Find existing segments
        let segments = find_segments(&config.dir)?;

        let (current_segment, current_lsn, checkpoint_lsn) = if segments.is_empty() {
            // Create first segment
            let segment = WalSegment::create(&config.dir, 1, 0)?;
            (segment, 0, 0)
        } else {
            // Open last segment for append
            let last_segment_id = *segments.last().unwrap();
            let (segment, last_lsn) = WalSegment::open_for_append(&config.dir, last_segment_id)?;
            let checkpoint_lsn = read_checkpoint(&config.dir).unwrap_or(0);
            (segment, last_lsn, checkpoint_lsn)
        };

        Ok(Self {
            config,
            current_segment: Mutex::new(current_segment),
            current_lsn: AtomicU64::new(current_lsn),
            flushed_lsn: AtomicU64::new(current_lsn),
            checkpoint_lsn: AtomicU64::new(checkpoint_lsn),
            ops_since_checkpoint: AtomicU64::new(0),
        })
    }

    /// Append a record to the WAL
    ///
    /// Returns the LSN assigned to this record.
    pub fn append(&self, mut record: WalRecord) -> std::result::Result<u64, WalError> {
        // Assign LSN
        let lsn = self.current_lsn.fetch_add(1, Ordering::SeqCst) + 1;
        record.lsn = lsn;
        record.timestamp = current_timestamp();

        // Serialize record
        let data = record.serialize()?;
        let record_size = data.len() as u64 + 8; // data + length prefix + CRC

        // Write to segment (may rotate)
        {
            let mut segment = self.current_segment.lock();

            // Check if we need to rotate
            if segment.position + record_size > self.config.max_segment_size {
                self.rotate_segment_locked(&mut segment, lsn)?;
            }

            // Write record
            segment.write_record(&data)?;

            // Sync based on mode
            if self.config.sync_mode == SyncMode::EveryWrite {
                segment.sync()?;
                self.flushed_lsn.store(lsn, Ordering::Release);
            }
        }

        // Update counters
        self.ops_since_checkpoint.fetch_add(1, Ordering::Relaxed);

        Ok(lsn)
    }

    /// Force sync to disk
    pub fn sync(&self) -> std::result::Result<(), WalError> {
        let mut segment = self.current_segment.lock();
        segment.sync()?;
        let current = self.current_lsn.load(Ordering::Acquire);
        self.flushed_lsn.store(current, Ordering::Release);
        Ok(())
    }

    /// Create a checkpoint
    ///
    /// Call this after flushing the main data store to disk.
    pub fn checkpoint(
        &self,
        flushed_lsn: u64,
        vector_count: u64,
    ) -> std::result::Result<(), WalError> {
        // Write checkpoint record
        let checkpoint_record = WalRecord::new_checkpoint(flushed_lsn, vector_count);
        self.append(checkpoint_record)?;

        // Sync to ensure checkpoint record is durable
        self.sync()?;

        // Write checkpoint file
        write_checkpoint(&self.config.dir, flushed_lsn)?;

        // Update state
        self.checkpoint_lsn.store(flushed_lsn, Ordering::Release);
        self.ops_since_checkpoint.store(0, Ordering::Relaxed);

        Ok(())
    }

    /// Truncate WAL segments that are fully checkpointed
    ///
    /// Removes segment files where all records have LSN <= checkpoint_lsn.
    pub fn truncate(&self) -> std::result::Result<u64, WalError> {
        let checkpoint_lsn = self.checkpoint_lsn.load(Ordering::Acquire);
        let segments = find_segments(&self.config.dir)?;
        let current_segment_id = self.current_segment.lock().id;

        let mut bytes_freed = 0u64;

        for segment_id in segments {
            // Never delete the current segment
            if segment_id == current_segment_id {
                continue;
            }

            let path = segment_path(&self.config.dir, segment_id);

            // Read header to check prev_segment_lsn
            let file = File::open(&path)?;
            let mut reader = BufReader::new(file);
            let mut header_bytes = [0u8; WAL_HEADER_SIZE];
            reader.read_exact(&mut header_bytes)?;
            let header = WalHeader::from_bytes(&header_bytes)?;

            // If the next segment starts after our checkpoint, this segment is needed
            // Otherwise, if this segment's last LSN (header of NEXT segment's prev_segment_lsn)
            // is before checkpoint, we can delete it
            // For safety, we only delete if the entire segment is before checkpoint
            if header.prev_segment_lsn < checkpoint_lsn && segment_id < current_segment_id {
                let size = std::fs::metadata(&path)?.len();
                std::fs::remove_file(&path)?;
                bytes_freed += size;
            }
        }

        Ok(bytes_freed)
    }

    /// Get current LSN
    pub fn current_lsn(&self) -> u64 {
        self.current_lsn.load(Ordering::Acquire)
    }

    /// Get last flushed LSN
    pub fn flushed_lsn(&self) -> u64 {
        self.flushed_lsn.load(Ordering::Acquire)
    }

    /// Get last checkpoint LSN
    pub fn checkpoint_lsn(&self) -> u64 {
        self.checkpoint_lsn.load(Ordering::Acquire)
    }

    /// Get operations since last checkpoint
    pub fn ops_since_checkpoint(&self) -> u64 {
        self.ops_since_checkpoint.load(Ordering::Relaxed)
    }

    /// Get the WAL directory path
    pub fn dir(&self) -> &Path {
        &self.config.dir
    }

    /// Rotate to a new segment
    fn rotate_segment_locked(
        &self,
        segment: &mut WalSegment,
        current_lsn: u64,
    ) -> std::result::Result<(), WalError> {
        // Sync current segment
        segment.sync()?;

        // Create new segment
        let new_id = segment.id + 1;
        let new_segment = WalSegment::create(&self.config.dir, new_id, current_lsn)?;
        *segment = new_segment;

        Ok(())
    }
}

// ============================================================================
// Recovery Iterator
// ============================================================================

/// Iterator over WAL records for recovery
pub struct WalRecoveryIterator {
    /// Segments to read, in order
    segments: Vec<PathBuf>,
    /// Current segment index
    current_segment_idx: usize,
    /// Current segment reader
    reader: Option<BufReader<File>>,
    /// Current position in segment
    position: u64,
    /// File length of current segment
    file_len: u64,
    /// Start LSN (skip records before this)
    start_lsn: u64,
    /// Whether we've encountered an error
    errored: bool,
}

impl WalRecoveryIterator {
    /// Create a new recovery iterator
    pub fn new(dir: &Path, start_lsn: u64) -> std::result::Result<Self, WalError> {
        let segment_ids = find_segments(dir)?;
        let segments: Vec<PathBuf> = segment_ids
            .iter()
            .map(|id| segment_path(dir, *id))
            .collect();

        Ok(Self {
            segments,
            current_segment_idx: 0,
            reader: None,
            position: 0,
            file_len: 0,
            start_lsn,
            errored: false,
        })
    }

    /// Open the next segment
    fn open_next_segment(&mut self) -> std::result::Result<bool, WalError> {
        if self.current_segment_idx >= self.segments.len() {
            return Ok(false);
        }

        let path = &self.segments[self.current_segment_idx];
        let file = File::open(path)?;
        self.file_len = file.metadata()?.len();

        let mut reader = BufReader::new(file);

        // Read and validate header
        let mut header_bytes = [0u8; WAL_HEADER_SIZE];
        reader.read_exact(&mut header_bytes)?;
        let header = WalHeader::from_bytes(&header_bytes)?;
        header.validate()?;

        self.reader = Some(reader);
        self.position = WAL_HEADER_SIZE as u64;
        self.current_segment_idx += 1;

        Ok(true)
    }

    /// Read the next record
    fn read_next_record(&mut self) -> std::result::Result<Option<WalRecord>, WalError> {
        loop {
            // Open next segment if needed
            if self.reader.is_none() && !self.open_next_segment()? {
                return Ok(None);
            }

            let reader = self.reader.as_mut().unwrap();

            // Check if we've reached end of segment
            if self.position >= self.file_len {
                self.reader = None;
                continue;
            }

            // Read length prefix
            let mut len_bytes = [0u8; 4];
            match reader.read_exact(&mut len_bytes) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    // End of segment
                    self.reader = None;
                    continue;
                }
                Err(e) => return Err(WalError::from(e)),
            }
            let record_len = u32::from_le_bytes(len_bytes) as usize;

            // Check if record fits in remaining file
            if self.position + 4 + record_len as u64 + 4 > self.file_len {
                // Incomplete record at end
                self.reader = None;
                continue;
            }

            // Read record data
            let mut record_data = vec![0u8; record_len];
            reader.read_exact(&mut record_data)?;

            // Read and verify CRC
            let mut crc_bytes = [0u8; 4];
            reader.read_exact(&mut crc_bytes)?;
            let stored_crc = u32::from_le_bytes(crc_bytes);
            let computed_crc = compute_crc(&record_data);

            self.position += 4 + record_len as u64 + 4;

            if stored_crc != computed_crc {
                // Corrupted record - stop recovery at this point
                return Err(WalError::ChecksumMismatch {
                    lsn: 0, // Unknown
                    expected: stored_crc,
                    actual: computed_crc,
                });
            }

            // Deserialize record
            let record = WalRecord::deserialize(&record_data)?;

            // Skip records before start_lsn
            if record.lsn <= self.start_lsn {
                continue;
            }

            return Ok(Some(record));
        }
    }
}

impl Iterator for WalRecoveryIterator {
    type Item = std::result::Result<WalRecord, WalError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.errored {
            return None;
        }

        match self.read_next_record() {
            Ok(Some(record)) => Some(Ok(record)),
            Ok(None) => None,
            Err(e) => {
                self.errored = true;
                Some(Err(e))
            }
        }
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Compute CRC32 checksum
fn compute_crc(data: &[u8]) -> u32 {
    let mut hasher = Hasher::new();
    hasher.update(data);
    hasher.finalize()
}

/// Get current timestamp in milliseconds
fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Get path to a segment file
fn segment_path(dir: &Path, id: u64) -> PathBuf {
    dir.join(format!("{}{:06}", WAL_SEGMENT_PREFIX, id))
}

/// Find all segment IDs in the WAL directory
fn find_segments(dir: &Path) -> std::result::Result<Vec<u64>, WalError> {
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut segments: Vec<u64> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            e.file_name()
                .to_str()
                .and_then(|name| name.strip_prefix(WAL_SEGMENT_PREFIX))
                .and_then(|num| num.parse().ok())
        })
        .collect();

    segments.sort();
    Ok(segments)
}

/// Read checkpoint LSN from checkpoint file
fn read_checkpoint(dir: &Path) -> std::result::Result<u64, WalError> {
    let path = dir.join(CHECKPOINT_FILENAME);
    if !path.exists() {
        return Ok(0);
    }

    let data = std::fs::read(&path)?;
    if data.len() < 8 {
        return Err(WalError::Corrupted("checkpoint file too short".into()));
    }

    Ok(u64::from_le_bytes(data[..8].try_into().unwrap()))
}

/// Write checkpoint LSN to checkpoint file
fn write_checkpoint(dir: &Path, lsn: u64) -> std::result::Result<(), WalError> {
    let path = dir.join(CHECKPOINT_FILENAME);
    let temp_path = dir.join(format!("{}.tmp", CHECKPOINT_FILENAME));

    // Atomic write via temp file + rename
    std::fs::write(&temp_path, lsn.to_le_bytes())?;
    std::fs::rename(&temp_path, &path)?;

    Ok(())
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_wal_record_serialization_roundtrip() {
        let record = WalRecord::new_insert("doc1".to_string(), 42, vec![1.0, 2.0, 3.0, 4.0]);

        let serialized = record.serialize().unwrap();
        let deserialized = WalRecord::deserialize(&serialized).unwrap();

        assert_eq!(deserialized.lsn, record.lsn);
        match deserialized.record_type {
            RecordType::Insert {
                external_id,
                internal_id,
                vector,
            } => {
                assert_eq!(external_id, "doc1");
                assert_eq!(internal_id, 42);
                assert_eq!(vector, vec![1.0, 2.0, 3.0, 4.0]);
            }
            _ => panic!("unexpected record type"),
        }
    }

    #[test]
    fn test_wal_record_delete_serialization() {
        let record = WalRecord::new_delete("doc1".to_string(), 42);
        let serialized = record.serialize().unwrap();
        let deserialized = WalRecord::deserialize(&serialized).unwrap();

        match deserialized.record_type {
            RecordType::Delete {
                external_id,
                internal_id,
            } => {
                assert_eq!(external_id, "doc1");
                assert_eq!(internal_id, 42);
            }
            _ => panic!("unexpected record type"),
        }
    }

    #[test]
    fn test_wal_record_batch_insert_serialization() {
        let record = WalRecord::new_batch_insert(
            vec!["doc1".to_string(), "doc2".to_string()],
            0,
            vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0],
            4,
        );

        let serialized = record.serialize().unwrap();
        let deserialized = WalRecord::deserialize(&serialized).unwrap();

        match deserialized.record_type {
            RecordType::BatchInsert {
                external_ids,
                start_internal_id,
                vectors_flat,
                dimensions,
            } => {
                assert_eq!(external_ids, vec!["doc1", "doc2"]);
                assert_eq!(start_internal_id, 0);
                assert_eq!(vectors_flat.len(), 8);
                assert_eq!(dimensions, 4);
            }
            _ => panic!("unexpected record type"),
        }
    }

    #[test]
    fn test_wal_record_checkpoint_serialization() {
        let record = WalRecord::new_checkpoint(100, 50);
        let serialized = record.serialize().unwrap();
        let deserialized = WalRecord::deserialize(&serialized).unwrap();

        match deserialized.record_type {
            RecordType::Checkpoint {
                last_flushed_lsn,
                vector_count,
            } => {
                assert_eq!(last_flushed_lsn, 100);
                assert_eq!(vector_count, 50);
            }
            _ => panic!("unexpected record type"),
        }
    }

    #[test]
    fn test_wal_header_serialization() {
        let header = WalHeader::new(1, 0);
        let bytes = header.to_bytes();
        let recovered = WalHeader::from_bytes(&bytes).unwrap();

        assert_eq!(recovered.magic, WAL_MAGIC);
        assert_eq!(recovered.version, WAL_VERSION);
        assert_eq!(recovered.segment_id, 1);
        assert_eq!(recovered.prev_segment_lsn, 0);
    }

    #[test]
    fn test_wal_header_validation() {
        let mut header = WalHeader::new(1, 0);
        assert!(header.validate().is_ok());

        // Invalid magic
        header.magic = 0x12345678;
        assert!(matches!(
            header.validate(),
            Err(WalError::InvalidMagic(0x12345678))
        ));

        // Unsupported version
        header.magic = WAL_MAGIC;
        header.version = 99;
        assert!(matches!(
            header.validate(),
            Err(WalError::UnsupportedVersion(99))
        ));
    }

    #[test]
    fn test_crc_checksum() {
        let data = b"hello world";
        let crc1 = compute_crc(data);
        let crc2 = compute_crc(data);
        assert_eq!(crc1, crc2);

        let different_data = b"hello world!";
        let crc3 = compute_crc(different_data);
        assert_ne!(crc1, crc3);
    }

    #[test]
    fn test_checksum_catches_corruption() {
        let record = WalRecord::new_insert("doc1".to_string(), 0, vec![1.0, 2.0, 3.0, 4.0]);
        let mut serialized = record.serialize().unwrap();

        // Corrupt one byte
        serialized[0] ^= 0xFF;

        // Deserialization should fail or produce different data
        let result = WalRecord::deserialize(&serialized);
        assert!(
            result.is_err()
                || result.as_ref().map(|r| &r.record_type)
                    != Ok(&RecordType::Insert {
                        external_id: "doc1".to_string(),
                        internal_id: 0,
                        vector: vec![1.0, 2.0, 3.0, 4.0]
                    })
        );
    }

    #[test]
    fn test_wal_create_and_append() {
        let dir = tempdir().unwrap();
        let config = WalConfig::new(dir.path().join("wal"));

        let wal = Wal::open(config).unwrap();
        assert_eq!(wal.current_lsn(), 0);

        let record = WalRecord::new_insert("doc1".to_string(), 0, vec![1.0, 2.0, 3.0, 4.0]);
        let lsn = wal.append(record).unwrap();
        assert_eq!(lsn, 1);
        assert_eq!(wal.current_lsn(), 1);
    }

    #[test]
    fn test_wal_sync() {
        let dir = tempdir().unwrap();
        let config = WalConfig {
            dir: dir.path().join("wal"),
            sync_mode: SyncMode::None, // Manual sync
            ..WalConfig::new(PathBuf::new())
        };

        let wal = Wal::open(config).unwrap();

        let record = WalRecord::new_insert("doc1".to_string(), 0, vec![1.0, 2.0]);
        wal.append(record).unwrap();

        assert_eq!(wal.flushed_lsn(), 0); // Not synced yet

        wal.sync().unwrap();
        assert_eq!(wal.flushed_lsn(), 1); // Now synced
    }

    #[test]
    fn test_wal_reopen() {
        let dir = tempdir().unwrap();
        let wal_dir = dir.path().join("wal");

        // Create and write some records
        {
            let config = WalConfig::new(wal_dir.clone());
            let wal = Wal::open(config).unwrap();

            for i in 0..5 {
                let record = WalRecord::new_insert(format!("doc{}", i), i, vec![i as f32; 4]);
                wal.append(record).unwrap();
            }
            wal.sync().unwrap();
        }

        // Reopen and verify
        {
            let config = WalConfig::new(wal_dir);
            let wal = Wal::open(config).unwrap();
            assert_eq!(wal.current_lsn(), 5);
        }
    }

    #[test]
    fn test_wal_recovery_iterator() {
        let dir = tempdir().unwrap();
        let wal_dir = dir.path().join("wal");

        // Create and write records
        {
            let config = WalConfig::new(wal_dir.clone());
            let wal = Wal::open(config).unwrap();

            for i in 0..10 {
                let record = WalRecord::new_insert(format!("doc{}", i), i, vec![i as f32; 4]);
                wal.append(record).unwrap();
            }
            wal.sync().unwrap();
        }

        // Recover all records
        {
            let iter = WalRecoveryIterator::new(&wal_dir, 0).unwrap();
            let records: Vec<_> = iter.collect();
            assert_eq!(records.len(), 10);

            for (i, result) in records.iter().enumerate() {
                let record = result.as_ref().unwrap();
                assert_eq!(record.lsn, (i + 1) as u64);
            }
        }

        // Recover from checkpoint at LSN 5
        {
            let iter = WalRecoveryIterator::new(&wal_dir, 5).unwrap();
            let records: Vec<_> = iter.collect();
            assert_eq!(records.len(), 5); // LSNs 6-10

            for (i, result) in records.iter().enumerate() {
                let record = result.as_ref().unwrap();
                assert_eq!(record.lsn, (i + 6) as u64);
            }
        }
    }

    #[test]
    fn test_wal_checkpoint() {
        let dir = tempdir().unwrap();
        let wal_dir = dir.path().join("wal");

        let config = WalConfig::new(wal_dir.clone());
        let wal = Wal::open(config).unwrap();

        // Write some records
        for i in 0..5 {
            let record = WalRecord::new_insert(format!("doc{}", i), i, vec![1.0; 4]);
            wal.append(record).unwrap();
        }

        // Checkpoint
        wal.checkpoint(5, 5).unwrap();
        assert_eq!(wal.checkpoint_lsn(), 5);

        // Verify checkpoint file exists
        assert!(wal_dir.join("checkpoint").exists());
    }

    #[test]
    fn test_wal_segment_rotation() {
        let dir = tempdir().unwrap();
        let wal_dir = dir.path().join("wal");

        // Very small segment size to force rotation
        let config = WalConfig {
            dir: wal_dir.clone(),
            max_segment_size: 200, // Very small
            ..WalConfig::new(PathBuf::new())
        };

        let wal = Wal::open(config).unwrap();

        // Write enough records to trigger rotation
        for i in 0..20 {
            let record = WalRecord::new_insert(format!("doc{}", i), i, vec![i as f32; 4]);
            wal.append(record).unwrap();
        }
        wal.sync().unwrap();

        // Should have multiple segments
        let segments = find_segments(&wal_dir).unwrap();
        assert!(
            segments.len() > 1,
            "Expected multiple segments, got {:?}",
            segments
        );
    }

    #[test]
    fn test_empty_wal_recovery() {
        let dir = tempdir().unwrap();
        let wal_dir = dir.path().join("wal");

        // Create WAL but don't write anything
        {
            let config = WalConfig::new(wal_dir.clone());
            let _wal = Wal::open(config).unwrap();
        }

        // Recovery should return empty iterator
        let iter = WalRecoveryIterator::new(&wal_dir, 0).unwrap();
        let records: Vec<_> = iter.collect();
        assert_eq!(records.len(), 0);
    }

    #[test]
    fn test_segment_path_format() {
        let dir = PathBuf::from("/tmp/wal");
        assert_eq!(segment_path(&dir, 1), PathBuf::from("/tmp/wal/wal.000001"));
        assert_eq!(
            segment_path(&dir, 123),
            PathBuf::from("/tmp/wal/wal.000123")
        );
        assert_eq!(
            segment_path(&dir, 999999),
            PathBuf::from("/tmp/wal/wal.999999")
        );
    }
}
