//! File headers for persistent storage
//!
//! All headers are 64 bytes with explicit padding to ensure
//! bytemuck compatibility and forward compatibility.

use bytemuck::{Pod, Zeroable};

/// Magic number for vector store files: "EMBD" in little-endian
pub const VECTOR_MAGIC: u32 = 0x44424D45;

/// Current version of vector store format
/// Version 2 adds CRC32 checksum
pub const VECTOR_VERSION: u32 = 2;

/// Header size in bytes (fixed for all versions)
pub const HEADER_SIZE: usize = 64;

/// Vector store file header
///
/// Layout (64 bytes total):
/// - magic: 4 bytes
/// - version: 4 bytes
/// - dimensions: 4 bytes
/// - checksum: 4 bytes (CRC32 of header fields, excluding checksum itself)
/// - count: 8 bytes
/// - deleted_count: 8 bytes
/// - _reserved2: 32 bytes (future use)
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct VectorHeader {
    /// Magic number to identify file type
    pub magic: u32,
    /// Format version for migrations
    pub version: u32,
    /// Vector dimensions
    pub dimensions: u32,
    /// CRC32 checksum of header fields (magic, version, dimensions, count, deleted_count)
    /// This field is set to 0 during checksum calculation
    pub checksum: u32,
    /// Number of vectors stored
    pub count: u64,
    /// Number of deleted vectors (for compaction decisions)
    pub deleted_count: u64,
    /// Reserved for future use
    pub _reserved2: [u8; 32],
}

impl VectorHeader {
    /// Create a new header for a fresh database
    pub fn new(dimensions: u32) -> Self {
        let mut header = Self {
            magic: VECTOR_MAGIC,
            version: VECTOR_VERSION,
            dimensions,
            checksum: 0,
            count: 0,
            deleted_count: 0,
            _reserved2: [0; 32],
        };
        header.checksum = header.calculate_checksum();
        header
    }

    /// Calculate CRC32 checksum of header fields
    /// The checksum field is treated as 0 during calculation
    pub fn calculate_checksum(&self) -> u32 {
        let mut hasher = crc32fast::Hasher::new();
        hasher.update(&self.magic.to_le_bytes());
        hasher.update(&self.version.to_le_bytes());
        hasher.update(&self.dimensions.to_le_bytes());
        // Skip checksum field (treated as 0)
        hasher.update(&self.count.to_le_bytes());
        hasher.update(&self.deleted_count.to_le_bytes());
        hasher.finalize()
    }

    /// Update the checksum based on current header values
    pub fn update_checksum(&mut self) {
        self.checksum = self.calculate_checksum();
    }

    /// Verify the checksum matches the header contents
    pub fn verify_checksum(&self) -> bool {
        // Version 1 headers don't have checksums (reserved1 was always 0)
        if self.version < 2 {
            return true;
        }
        self.checksum == self.calculate_checksum()
    }

    /// Validate header magic and version
    pub fn validate(&self) -> Result<(), HeaderError> {
        if self.magic != VECTOR_MAGIC {
            return Err(HeaderError::InvalidMagic {
                expected: VECTOR_MAGIC,
                got: self.magic,
            });
        }
        if self.version > VECTOR_VERSION {
            return Err(HeaderError::UnsupportedVersion {
                max_supported: VECTOR_VERSION,
                got: self.version,
            });
        }
        Ok(())
    }

    /// Validate header including checksum verification
    pub fn validate_with_checksum(&self) -> Result<(), HeaderError> {
        self.validate()?;
        if !self.verify_checksum() {
            return Err(HeaderError::ChecksumMismatch {
                expected: self.calculate_checksum(),
                got: self.checksum,
            });
        }
        Ok(())
    }
}

/// Magic number for HNSW index files: "HNSW" in little-endian
#[allow(dead_code)]
pub const HNSW_MAGIC: u32 = 0x57534E48;

/// Current version of HNSW format
#[allow(dead_code)]
pub const HNSW_VERSION: u32 = 1;

/// HNSW index file header
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct HnswHeader {
    /// Magic number
    pub magic: u32,
    /// Format version
    pub version: u32,
    /// Number of vectors in index
    pub count: u32,
    /// Entry point node ID
    pub entry_point: u32,
    /// Maximum level in the graph
    pub max_level: u32,
    /// M parameter (connections per node)
    pub m: u32,
    /// M_max0 parameter (connections at layer 0)
    pub m_max0: u32,
    /// ef_construction parameter
    pub ef_construction: u32,
    /// Reserved for future use
    pub _reserved: [u8; 32],
}

#[allow(dead_code)]
impl HnswHeader {
    pub fn new(m: u32, m_max0: u32, ef_construction: u32) -> Self {
        Self {
            magic: HNSW_MAGIC,
            version: HNSW_VERSION,
            count: 0,
            entry_point: u32::MAX, // Invalid until first insert
            max_level: 0,
            m,
            m_max0,
            ef_construction,
            _reserved: [0; 32],
        }
    }

    pub fn validate(&self) -> Result<(), HeaderError> {
        if self.magic != HNSW_MAGIC {
            return Err(HeaderError::InvalidMagic {
                expected: HNSW_MAGIC,
                got: self.magic,
            });
        }
        if self.version > HNSW_VERSION {
            return Err(HeaderError::UnsupportedVersion {
                max_supported: HNSW_VERSION,
                got: self.version,
            });
        }
        Ok(())
    }
}

/// Magic number for ID map files: "IDMP" in little-endian
pub const IDMAP_MAGIC: u32 = 0x504D4449;

/// Current version of ID map format
pub const IDMAP_VERSION: u32 = 1;

/// ID map file header
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct IdMapHeader {
    /// Magic number
    pub magic: u32,
    /// Format version
    pub version: u32,
    /// Number of entries
    pub count: u32,
    /// Reserved for alignment
    pub _reserved1: u32,
    /// Reserved for future use
    pub _reserved2: [u8; 16],
}

#[allow(dead_code)]
impl IdMapHeader {
    pub fn new() -> Self {
        Self {
            magic: IDMAP_MAGIC,
            version: IDMAP_VERSION,
            count: 0,
            _reserved1: 0,
            _reserved2: [0; 16],
        }
    }

    pub fn validate(&self) -> Result<(), HeaderError> {
        if self.magic != IDMAP_MAGIC {
            return Err(HeaderError::InvalidMagic {
                expected: IDMAP_MAGIC,
                got: self.magic,
            });
        }
        if self.version > IDMAP_VERSION {
            return Err(HeaderError::UnsupportedVersion {
                max_supported: IDMAP_VERSION,
                got: self.version,
            });
        }
        Ok(())
    }
}

impl Default for IdMapHeader {
    fn default() -> Self {
        Self::new()
    }
}

/// Header validation errors
#[derive(Debug, Clone, thiserror::Error)]
pub enum HeaderError {
    #[error("invalid magic number: expected 0x{expected:08X}, got 0x{got:08X}")]
    InvalidMagic { expected: u32, got: u32 },
    #[error("unsupported version: max supported {max_supported}, got {got}")]
    UnsupportedVersion { max_supported: u32, got: u32 },
    #[error(
        "checksum mismatch: expected 0x{expected:08X}, got 0x{got:08X} (file may be corrupted)"
    )]
    ChecksumMismatch { expected: u32, got: u32 },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vector_header_size() {
        assert_eq!(std::mem::size_of::<VectorHeader>(), HEADER_SIZE);
    }

    #[test]
    fn test_hnsw_header_size() {
        assert_eq!(std::mem::size_of::<HnswHeader>(), HEADER_SIZE);
    }

    #[test]
    fn test_idmap_header_size() {
        // ID map header is 32 bytes
        assert_eq!(std::mem::size_of::<IdMapHeader>(), 32);
    }

    #[test]
    fn test_vector_header_validation() {
        let header = VectorHeader::new(384);
        assert!(header.validate().is_ok());

        let bad_magic = VectorHeader {
            magic: 0xDEADBEEF,
            ..header
        };
        assert!(bad_magic.validate().is_err());

        let future_version = VectorHeader {
            version: 999,
            ..header
        };
        assert!(future_version.validate().is_err());
    }

    #[test]
    fn test_vector_header_checksum() {
        let header = VectorHeader::new(384);

        // New header should have valid checksum
        assert!(header.verify_checksum());
        assert!(header.validate_with_checksum().is_ok());

        // Checksum should be non-zero for v2 headers
        assert_ne!(header.checksum, 0);
    }

    #[test]
    fn test_checksum_detects_corruption() {
        let mut header = VectorHeader::new(384);

        // Corrupt the dimensions without updating checksum
        header.dimensions = 512;

        // Checksum should now fail
        assert!(!header.verify_checksum());
        assert!(matches!(
            header.validate_with_checksum(),
            Err(HeaderError::ChecksumMismatch { .. })
        ));

        // After updating checksum, it should pass
        header.update_checksum();
        assert!(header.verify_checksum());
        assert!(header.validate_with_checksum().is_ok());
    }

    #[test]
    fn test_checksum_detects_count_corruption() {
        let mut header = VectorHeader::new(384);
        let original_checksum = header.checksum;

        // Corrupt the count
        header.count = 99999;

        // Checksum should fail (count is part of checksum)
        assert!(!header.verify_checksum());

        // Restore and verify
        header.count = 0;
        assert_eq!(header.checksum, original_checksum);
        assert!(header.verify_checksum());
    }

    #[test]
    fn test_v1_header_checksum_bypass() {
        // Simulate a v1 header (checksum field was reserved1 = 0)
        let v1_header = VectorHeader {
            magic: VECTOR_MAGIC,
            version: 1,
            dimensions: 384,
            checksum: 0, // v1 had this as _reserved1
            count: 100,
            deleted_count: 5,
            _reserved2: [0; 32],
        };

        // v1 headers should pass checksum verification (backwards compatibility)
        assert!(v1_header.verify_checksum());
    }
}
