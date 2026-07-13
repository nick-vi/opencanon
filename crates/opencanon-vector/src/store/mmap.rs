//! Memory-mapped vector storage
//!
//! Provides efficient access to vectors through memory mapping,
//! allowing the OS to handle paging and caching.

use super::header::{VectorHeader, HEADER_SIZE};
use crate::{EmbedDbError, Result};
use bytemuck;
use memmap2::{MmapMut, MmapOptions};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

/// Memory-mapped vector store
pub struct MmapVectorStore {
    file: File,
    mmap: Option<MmapMut>,
    dimensions: usize,
    count: usize,
    path: PathBuf,
}

impl MmapVectorStore {
    /// Open or create a vector store at the given directory
    pub fn open(dir: &Path, dimensions: usize) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("vectors.bin");

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;

        let metadata = file.metadata()?;
        let is_new = metadata.len() == 0;

        let mut store = Self {
            file,
            mmap: None,
            dimensions,
            count: 0,
            path,
        };

        if is_new {
            store.initialize()?;
        } else {
            store.load()?;
        }

        Ok(store)
    }

    /// Initialize a new empty store
    fn initialize(&mut self) -> Result<()> {
        let header = VectorHeader::new(self.dimensions as u32);

        // Set file size to header only initially
        self.file.set_len(HEADER_SIZE as u64)?;

        // Memory map and write header
        let mut mmap = unsafe { MmapOptions::new().map_mut(&self.file)? };
        let header_bytes = bytemuck::bytes_of(&header);
        mmap[..HEADER_SIZE].copy_from_slice(header_bytes);
        mmap.flush()?;

        self.mmap = Some(mmap);
        self.count = 0;
        Ok(())
    }

    /// Load an existing store
    fn load(&mut self) -> Result<()> {
        let mmap = unsafe { MmapOptions::new().map_mut(&self.file)? };

        if mmap.len() < HEADER_SIZE {
            return Err(EmbedDbError::Corrupted("file too small for header".into()));
        }

        let header: VectorHeader = *bytemuck::from_bytes(&mmap[..HEADER_SIZE]);

        header
            .validate_with_checksum()
            .map_err(|error| EmbedDbError::Corrupted(error.to_string()))?;

        self.dimensions = header.dimensions as usize;
        self.count = header.count as usize;
        self.mmap = Some(mmap);

        // Validate file size
        let expected_size = self.file_size_for_count(self.count);
        let actual_size = self.file.metadata()?.len() as usize;
        if actual_size < expected_size {
            return Err(EmbedDbError::Corrupted(format!(
                "file truncated: expected {} bytes, got {}",
                expected_size, actual_size
            )));
        }

        Ok(())
    }

    /// Calculate required file size for a given vector count
    fn file_size_for_count(&self, count: usize) -> usize {
        HEADER_SIZE + count * self.vector_bytes()
    }

    /// Size of a single vector in bytes
    fn vector_bytes(&self) -> usize {
        self.dimensions * std::mem::size_of::<f32>()
    }

    /// Append a vector, returning its index
    pub fn append(&mut self, vector: &[f32]) -> Result<usize> {
        if vector.len() != self.dimensions {
            return Err(EmbedDbError::DimensionMismatch {
                expected: self.dimensions,
                got: vector.len(),
            });
        }

        let idx = self.count;
        let vector_size = self.vector_bytes();
        let offset = HEADER_SIZE + idx * vector_size;
        let new_size = offset + vector_size;

        // Extend file if needed
        self.file.set_len(new_size as u64)?;

        // Remap to get new size
        let mut mmap = unsafe { MmapOptions::new().map_mut(&self.file)? };

        // Write vector
        let vector_bytes = bytemuck::cast_slice(vector);
        mmap[offset..offset + vector_size].copy_from_slice(vector_bytes);

        // Update header count and checksum
        self.count += 1;
        self.write_header_count_and_checksum(&mut mmap);

        self.mmap = Some(mmap);
        Ok(idx)
    }

    /// Write the count and recalculate checksum in the header
    fn write_header_count_and_checksum(&self, mmap: &mut MmapMut) {
        // Read current header
        let mut header: VectorHeader = *bytemuck::from_bytes(&mmap[..HEADER_SIZE]);

        // Update count
        header.count = self.count as u64;

        // Recalculate checksum
        header.update_checksum();

        // Write back entire header
        let header_bytes = bytemuck::bytes_of(&header);
        mmap[..HEADER_SIZE].copy_from_slice(header_bytes);
    }

    /// Batch append multiple vectors, returning their starting index
    ///
    /// This is more efficient than calling `append` multiple times because it:
    /// 1. Pre-allocates space for all vectors at once
    /// 2. Only remaps the file once
    ///
    /// Returns the index of the first inserted vector. Subsequent vectors
    /// have consecutive indices.
    pub fn append_batch(&mut self, vectors: &[Vec<f32>]) -> Result<usize> {
        if vectors.is_empty() {
            return Ok(self.count);
        }

        // Validate all dimensions first
        for vector in vectors.iter() {
            if vector.len() != self.dimensions {
                return Err(EmbedDbError::DimensionMismatch {
                    expected: self.dimensions,
                    got: vector.len(),
                });
            }
        }

        let start_idx = self.count;
        let vector_size = self.vector_bytes();
        let total_vectors = vectors.len();
        let total_new_bytes = total_vectors * vector_size;
        let start_offset = HEADER_SIZE + start_idx * vector_size;
        let new_size = start_offset + total_new_bytes;

        // Pre-allocate space for all vectors at once
        self.file.set_len(new_size as u64)?;

        // Single remap for all vectors
        let mut mmap = unsafe { MmapOptions::new().map_mut(&self.file)? };

        // Write all vectors
        for (i, vector) in vectors.iter().enumerate() {
            let offset = start_offset + i * vector_size;
            let vector_bytes = bytemuck::cast_slice(vector);
            mmap[offset..offset + vector_size].copy_from_slice(vector_bytes);
        }

        // Update header count and checksum once
        self.count += total_vectors;
        self.write_header_count_and_checksum(&mut mmap);

        self.mmap = Some(mmap);
        Ok(start_idx)
    }

    /// Get a vector by index
    pub fn get(&self, idx: usize) -> Option<&[f32]> {
        if idx >= self.count {
            return None;
        }

        let mmap = self.mmap.as_ref()?;
        let vector_size = self.vector_bytes();
        let offset = HEADER_SIZE + idx * vector_size;

        if offset + vector_size > mmap.len() {
            return None;
        }

        let bytes = &mmap[offset..offset + vector_size];
        Some(bytemuck::cast_slice(bytes))
    }

    /// Get number of stored vectors
    pub fn len(&self) -> usize {
        self.count
    }

    /// Check if store is empty
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Get vector dimensions
    pub fn dimensions(&self) -> usize {
        self.dimensions
    }

    /// Flush changes to disk
    pub fn flush(&self) -> Result<()> {
        if let Some(ref mmap) = self.mmap {
            mmap.flush()?;
        }
        Ok(())
    }

    /// Get the file path
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Update deleted count in header (for metrics)
    pub fn set_deleted_count(&mut self, count: u64) -> Result<()> {
        if let Some(ref mut mmap) = self.mmap {
            let offset = std::mem::offset_of!(VectorHeader, deleted_count);
            mmap[offset..offset + 8].copy_from_slice(&count.to_le_bytes());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_create_and_reopen() {
        let dir = tempdir().unwrap();
        let dims = 4;

        // Create new store
        {
            let mut store = MmapVectorStore::open(dir.path(), dims).unwrap();
            assert_eq!(store.len(), 0);
            assert_eq!(store.dimensions(), dims);

            let v1 = vec![1.0, 2.0, 3.0, 4.0];
            let v2 = vec![5.0, 6.0, 7.0, 8.0];

            let idx1 = store.append(&v1).unwrap();
            let idx2 = store.append(&v2).unwrap();

            assert_eq!(idx1, 0);
            assert_eq!(idx2, 1);
            assert_eq!(store.len(), 2);

            store.flush().unwrap();
        }

        // Reopen and verify
        {
            let store = MmapVectorStore::open(dir.path(), dims).unwrap();
            assert_eq!(store.len(), 2);
            assert_eq!(store.dimensions(), dims);

            let v1 = store.get(0).unwrap();
            assert_eq!(v1, &[1.0, 2.0, 3.0, 4.0]);

            let v2 = store.get(1).unwrap();
            assert_eq!(v2, &[5.0, 6.0, 7.0, 8.0]);
        }
    }

    #[test]
    fn test_dimension_mismatch() {
        let dir = tempdir().unwrap();
        let mut store = MmapVectorStore::open(dir.path(), 4).unwrap();

        let wrong_dims = vec![1.0, 2.0, 3.0]; // 3 instead of 4
        let result = store.append(&wrong_dims);
        assert!(matches!(
            result,
            Err(EmbedDbError::DimensionMismatch { .. })
        ));
    }

    #[test]
    fn test_get_out_of_bounds() {
        let dir = tempdir().unwrap();
        let store = MmapVectorStore::open(dir.path(), 4).unwrap();
        assert!(store.get(0).is_none());
        assert!(store.get(100).is_none());
    }

    #[test]
    fn test_batch_append() {
        let dir = tempdir().unwrap();
        let dims = 4;

        let mut store = MmapVectorStore::open(dir.path(), dims).unwrap();

        let vectors = vec![
            vec![1.0, 2.0, 3.0, 4.0],
            vec![5.0, 6.0, 7.0, 8.0],
            vec![9.0, 10.0, 11.0, 12.0],
        ];

        let start_idx = store.append_batch(&vectors).unwrap();

        assert_eq!(start_idx, 0);
        assert_eq!(store.len(), 3);

        // Verify all vectors
        assert_eq!(store.get(0).unwrap(), &[1.0, 2.0, 3.0, 4.0]);
        assert_eq!(store.get(1).unwrap(), &[5.0, 6.0, 7.0, 8.0]);
        assert_eq!(store.get(2).unwrap(), &[9.0, 10.0, 11.0, 12.0]);
    }

    #[test]
    fn test_batch_append_after_single() {
        let dir = tempdir().unwrap();
        let dims = 4;

        let mut store = MmapVectorStore::open(dir.path(), dims).unwrap();

        // Single append first
        store.append(&[1.0, 1.0, 1.0, 1.0]).unwrap();

        // Then batch append
        let vectors = vec![vec![2.0, 2.0, 2.0, 2.0], vec![3.0, 3.0, 3.0, 3.0]];

        let start_idx = store.append_batch(&vectors).unwrap();

        assert_eq!(start_idx, 1);
        assert_eq!(store.len(), 3);

        assert_eq!(store.get(0).unwrap(), &[1.0, 1.0, 1.0, 1.0]);
        assert_eq!(store.get(1).unwrap(), &[2.0, 2.0, 2.0, 2.0]);
        assert_eq!(store.get(2).unwrap(), &[3.0, 3.0, 3.0, 3.0]);
    }

    #[test]
    fn test_batch_append_empty() {
        let dir = tempdir().unwrap();
        let dims = 4;

        let mut store = MmapVectorStore::open(dir.path(), dims).unwrap();
        store.append(&[1.0, 1.0, 1.0, 1.0]).unwrap();

        // Empty batch should return current count
        let start_idx = store.append_batch(&[]).unwrap();
        assert_eq!(start_idx, 1);
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn test_batch_append_dimension_mismatch() {
        let dir = tempdir().unwrap();
        let dims = 4;

        let mut store = MmapVectorStore::open(dir.path(), dims).unwrap();

        let vectors = vec![
            vec![1.0, 2.0, 3.0, 4.0],
            vec![5.0, 6.0, 7.0], // Wrong dimensions
        ];

        let result = store.append_batch(&vectors);
        assert!(matches!(
            result,
            Err(EmbedDbError::DimensionMismatch { .. })
        ));

        // Store should be unchanged
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn test_batch_append_persistence() {
        let dir = tempdir().unwrap();
        let dims = 4;

        // Create and batch append
        {
            let mut store = MmapVectorStore::open(dir.path(), dims).unwrap();
            let vectors = vec![vec![1.0, 2.0, 3.0, 4.0], vec![5.0, 6.0, 7.0, 8.0]];
            store.append_batch(&vectors).unwrap();
            store.flush().unwrap();
        }

        // Reopen and verify
        {
            let store = MmapVectorStore::open(dir.path(), dims).unwrap();
            assert_eq!(store.len(), 2);
            assert_eq!(store.get(0).unwrap(), &[1.0, 2.0, 3.0, 4.0]);
            assert_eq!(store.get(1).unwrap(), &[5.0, 6.0, 7.0, 8.0]);
        }
    }

    #[test]
    fn test_checksum_validation_on_load() {
        let dir = tempdir().unwrap();
        let dims = 4;

        // Create a valid store
        {
            let mut store = MmapVectorStore::open(dir.path(), dims).unwrap();
            store.append(&[1.0, 2.0, 3.0, 4.0]).unwrap();
            store.flush().unwrap();
        }

        // Reopen should succeed with valid checksum
        {
            let store = MmapVectorStore::open(dir.path(), dims).unwrap();
            assert_eq!(store.len(), 1);
        }
    }
}
