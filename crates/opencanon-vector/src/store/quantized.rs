//! Memory-mapped quantized vector storage
//!
//! Stores vectors as int8 with 4x memory savings compared to f32.
//! Includes quantization parameters (alpha, offset) for dequantization.

use crate::quantize::{
    QuantizationHeader, ScalarQuantizer, QUANTIZATION_MAGIC, QUANTIZATION_VERSION,
};
use crate::{EmbedDbError, Result};
use bytemuck;
use memmap2::{MmapMut, MmapOptions};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

/// Header size for quantized vector store
pub const QUANTIZED_HEADER_SIZE: usize = 16;

/// Memory-mapped quantized vector store
///
/// File format:
/// - Header (16 bytes): magic, version, dimensions, reserved
/// - Alpha array (dimensions * 4 bytes): f32 scale factors
/// - Offset array (dimensions * 4 bytes): f32 offsets
/// - Vectors (count * dimensions bytes): i8 quantized vectors
pub struct QuantizedVectorStore {
    file: File,
    mmap: Option<MmapMut>,
    dimensions: usize,
    count: usize,
    path: PathBuf,
    /// Cached quantizer for fast quantization/dequantization
    quantizer: Option<ScalarQuantizer>,
}

impl QuantizedVectorStore {
    /// Open or create a quantized vector store at the given directory
    ///
    /// The store file is named "vectors_q.bin" to distinguish from f32 vectors.
    pub fn open(dir: &Path, dimensions: usize) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("vectors_q.bin");

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
            quantizer: None,
        };

        if is_new {
            store.initialize()?;
        } else {
            store.load()?;
        }

        Ok(store)
    }

    /// Calculate the size of the parameters section (alpha + offset)
    fn params_size(&self) -> usize {
        self.dimensions * 4 * 2 // alpha (f32) + offset (f32)
    }

    /// Calculate the offset where vectors start
    fn vectors_offset(&self) -> usize {
        QUANTIZED_HEADER_SIZE + self.params_size()
    }

    /// Calculate required file size for a given vector count
    #[allow(dead_code)]
    fn file_size_for_count(&self, count: usize) -> usize {
        self.vectors_offset() + count * self.dimensions
    }

    /// Initialize a new empty store
    fn initialize(&mut self) -> Result<()> {
        let header = QuantizationHeader::new(self.dimensions as u32);

        // Set file size to header + params (no vectors yet)
        let initial_size = self.vectors_offset();
        self.file.set_len(initial_size as u64)?;

        // Memory map and write header
        let mut mmap = unsafe { MmapOptions::new().map_mut(&self.file)? };
        let header_bytes = bytemuck::bytes_of(&header);
        mmap[..QUANTIZED_HEADER_SIZE].copy_from_slice(header_bytes);

        // Initialize alpha and offset with zeros (will be set during training)
        let zeros = vec![0u8; self.params_size()];
        mmap[QUANTIZED_HEADER_SIZE..self.vectors_offset()].copy_from_slice(&zeros);

        mmap.flush()?;

        self.mmap = Some(mmap);
        self.count = 0;
        Ok(())
    }

    /// Load an existing store
    fn load(&mut self) -> Result<()> {
        let mmap = unsafe { MmapOptions::new().map_mut(&self.file)? };

        if mmap.len() < QUANTIZED_HEADER_SIZE {
            return Err(EmbedDbError::Corrupted(
                "quantized file too small for header".into(),
            ));
        }

        let header: QuantizationHeader = *bytemuck::from_bytes(&mmap[..QUANTIZED_HEADER_SIZE]);

        // Validate header
        if header.magic != QUANTIZATION_MAGIC {
            return Err(EmbedDbError::Corrupted(format!(
                "invalid quantization magic: expected 0x{:08X}, got 0x{:08X}",
                QUANTIZATION_MAGIC, header.magic
            )));
        }
        if header.version > QUANTIZATION_VERSION {
            return Err(EmbedDbError::Corrupted(format!(
                "unsupported quantization version: {}",
                header.version
            )));
        }

        self.dimensions = header.dimensions as usize;

        // Load quantization parameters
        let params_offset = QUANTIZED_HEADER_SIZE;
        let alpha_end = params_offset + self.dimensions * 4;
        let offset_end = alpha_end + self.dimensions * 4;

        let alpha: Vec<f32> = bytemuck::cast_slice(&mmap[params_offset..alpha_end]).to_vec();
        let offset: Vec<f32> = bytemuck::cast_slice(&mmap[alpha_end..offset_end]).to_vec();

        // Only create quantizer if params are non-zero (trained)
        if alpha.iter().any(|&a| a != 0.0) {
            self.quantizer = Some(ScalarQuantizer::from_params(alpha, offset));
        }

        // Calculate vector count from file size
        let vectors_start = self.vectors_offset();
        let vectors_bytes = mmap.len() - vectors_start;
        self.count = vectors_bytes / self.dimensions;

        self.mmap = Some(mmap);
        Ok(())
    }

    /// Train the quantizer on sample vectors
    ///
    /// Must be called before appending vectors. Computes and stores
    /// the quantization parameters (alpha, offset) for each dimension.
    pub fn train(&mut self, vectors: &[&[f32]]) -> Result<()> {
        if vectors.is_empty() {
            return Err(EmbedDbError::Corrupted(
                "cannot train quantizer on empty vector set".into(),
            ));
        }

        // Validate dimensions
        for v in vectors {
            if v.len() != self.dimensions {
                return Err(EmbedDbError::DimensionMismatch {
                    expected: self.dimensions,
                    got: v.len(),
                });
            }
        }

        let quantizer = ScalarQuantizer::train(vectors, self.dimensions);

        // Write parameters to file
        if let Some(ref mut mmap) = self.mmap {
            let params_offset = QUANTIZED_HEADER_SIZE;
            let alpha_end = params_offset + self.dimensions * 4;

            let alpha_bytes = bytemuck::cast_slice(quantizer.alpha());
            let offset_bytes = bytemuck::cast_slice(quantizer.offset());

            mmap[params_offset..alpha_end].copy_from_slice(alpha_bytes);
            mmap[alpha_end..alpha_end + self.dimensions * 4].copy_from_slice(offset_bytes);
            mmap.flush()?;
        }

        self.quantizer = Some(quantizer);
        Ok(())
    }

    /// Check if the quantizer has been trained
    pub fn is_trained(&self) -> bool {
        self.quantizer.is_some()
    }

    /// Get the quantizer (if trained)
    pub fn quantizer(&self) -> Option<&ScalarQuantizer> {
        self.quantizer.as_ref()
    }

    /// Append a quantized vector, returning its index
    ///
    /// The input f32 vector is automatically quantized using the trained parameters.
    /// Returns an error if the quantizer has not been trained.
    pub fn append(&mut self, vector: &[f32]) -> Result<usize> {
        if vector.len() != self.dimensions {
            return Err(EmbedDbError::DimensionMismatch {
                expected: self.dimensions,
                got: vector.len(),
            });
        }

        let quantizer = self
            .quantizer
            .as_ref()
            .ok_or_else(|| EmbedDbError::Corrupted("quantizer not trained".into()))?;

        let quantized = quantizer.quantize(vector);

        let idx = self.count;
        let offset = self.vectors_offset() + idx * self.dimensions;
        let new_size = offset + self.dimensions;

        // Extend file if needed
        self.file.set_len(new_size as u64)?;

        // Remap to get new size
        let mut mmap = unsafe { MmapOptions::new().map_mut(&self.file)? };

        // Write quantized vector (i8 as bytes)
        let quantized_bytes: &[u8] = bytemuck::cast_slice(&quantized);
        mmap[offset..offset + self.dimensions].copy_from_slice(quantized_bytes);

        self.count += 1;
        self.mmap = Some(mmap);
        Ok(idx)
    }

    /// Batch append multiple vectors
    ///
    /// More efficient than calling append multiple times.
    pub fn append_batch(&mut self, vectors: &[Vec<f32>]) -> Result<usize> {
        if vectors.is_empty() {
            return Ok(self.count);
        }

        let quantizer = self
            .quantizer
            .as_ref()
            .ok_or_else(|| EmbedDbError::Corrupted("quantizer not trained".into()))?;

        // Validate dimensions
        for v in vectors {
            if v.len() != self.dimensions {
                return Err(EmbedDbError::DimensionMismatch {
                    expected: self.dimensions,
                    got: v.len(),
                });
            }
        }

        let start_idx = self.count;
        let total_vectors = vectors.len();
        let start_offset = self.vectors_offset() + start_idx * self.dimensions;
        let new_size = start_offset + total_vectors * self.dimensions;

        // Pre-allocate space
        self.file.set_len(new_size as u64)?;

        // Single remap
        let mut mmap = unsafe { MmapOptions::new().map_mut(&self.file)? };

        // Quantize and write all vectors
        for (i, vector) in vectors.iter().enumerate() {
            let quantized = quantizer.quantize(vector);
            let offset = start_offset + i * self.dimensions;
            let quantized_bytes: &[u8] = bytemuck::cast_slice(&quantized);
            mmap[offset..offset + self.dimensions].copy_from_slice(quantized_bytes);
        }

        self.count += total_vectors;
        self.mmap = Some(mmap);
        Ok(start_idx)
    }

    /// Get a quantized vector by index as i8 slice
    pub fn get_quantized(&self, idx: usize) -> Option<&[i8]> {
        if idx >= self.count {
            return None;
        }

        let mmap = self.mmap.as_ref()?;
        let offset = self.vectors_offset() + idx * self.dimensions;

        if offset + self.dimensions > mmap.len() {
            return None;
        }

        let bytes = &mmap[offset..offset + self.dimensions];
        Some(bytemuck::cast_slice(bytes))
    }

    /// Get a vector by index, dequantized back to f32
    pub fn get(&self, idx: usize) -> Option<Vec<f32>> {
        let quantized = self.get_quantized(idx)?;
        let quantizer = self.quantizer.as_ref()?;
        Some(quantizer.dequantize(quantized))
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

    /// Calculate approximate memory usage compared to f32 storage
    ///
    /// Returns (quantized_bytes, f32_equivalent_bytes)
    pub fn memory_stats(&self) -> (usize, usize) {
        let quantized = self.vectors_offset() + self.count * self.dimensions;
        let f32_equivalent = 64 + self.count * self.dimensions * 4; // header + vectors
        (quantized, f32_equivalent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn create_test_vectors(count: usize, dims: usize) -> Vec<Vec<f32>> {
        (0..count)
            .map(|i| {
                (0..dims)
                    .map(|j| ((i * 17 + j * 31) % 100) as f32 / 100.0 - 0.5)
                    .collect()
            })
            .collect()
    }

    #[test]
    fn test_create_and_train() {
        let dir = tempdir().unwrap();
        let mut store = QuantizedVectorStore::open(dir.path(), 4).unwrap();

        assert!(!store.is_trained());
        assert_eq!(store.len(), 0);

        let vectors = [vec![0.0, 0.0, 0.0, 0.0], vec![1.0, 1.0, 1.0, 1.0]];
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        store.train(&refs).unwrap();
        assert!(store.is_trained());
    }

    #[test]
    fn test_append_and_get() {
        let dir = tempdir().unwrap();
        let mut store = QuantizedVectorStore::open(dir.path(), 4).unwrap();

        let vectors = [
            vec![0.0, 0.0, 0.0, 0.0],
            vec![1.0, 1.0, 1.0, 1.0],
            vec![0.5, 0.5, 0.5, 0.5],
        ];
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();
        store.train(&refs).unwrap();

        let idx = store.append(&vectors[0]).unwrap();
        assert_eq!(idx, 0);
        assert_eq!(store.len(), 1);

        let idx = store.append(&vectors[1]).unwrap();
        assert_eq!(idx, 1);
        assert_eq!(store.len(), 2);

        // Get dequantized should be close to original
        let retrieved = store.get(0).unwrap();
        for i in 0..4 {
            let error = (retrieved[i] - vectors[0][i]).abs();
            assert!(error < 0.01, "error {} too large at dim {}", error, i);
        }
    }

    #[test]
    fn test_batch_append() {
        let dir = tempdir().unwrap();
        let mut store = QuantizedVectorStore::open(dir.path(), 4).unwrap();

        let vectors = create_test_vectors(10, 4);
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();
        store.train(&refs).unwrap();

        let start = store.append_batch(&vectors).unwrap();
        assert_eq!(start, 0);
        assert_eq!(store.len(), 10);

        // Verify all vectors
        for (i, original) in vectors.iter().enumerate() {
            let retrieved = store.get(i).unwrap();
            for j in 0..4 {
                let error = (retrieved[j] - original[j]).abs();
                assert!(error < 0.02, "error {} at vec {} dim {}", error, i, j);
            }
        }
    }

    #[test]
    fn test_persistence() {
        let dir = tempdir().unwrap();

        let vectors = create_test_vectors(5, 4);

        // Create, train, and append
        {
            let mut store = QuantizedVectorStore::open(dir.path(), 4).unwrap();
            let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();
            store.train(&refs).unwrap();
            store.append_batch(&vectors).unwrap();
            store.flush().unwrap();
        }

        // Reopen and verify
        {
            let store = QuantizedVectorStore::open(dir.path(), 4).unwrap();
            assert!(store.is_trained());
            assert_eq!(store.len(), 5);

            for (i, original) in vectors.iter().enumerate() {
                let retrieved = store.get(i).unwrap();
                for j in 0..4 {
                    let error = (retrieved[j] - original[j]).abs();
                    assert!(error < 0.02, "error {} at vec {} dim {}", error, i, j);
                }
            }
        }
    }

    #[test]
    fn test_get_quantized() {
        let dir = tempdir().unwrap();
        let mut store = QuantizedVectorStore::open(dir.path(), 4).unwrap();

        let vectors = vec![vec![0.0, 0.5, 1.0, 0.25], vec![1.0, 0.0, 0.5, 0.75]];
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();
        store.train(&refs).unwrap();
        store.append_batch(&vectors).unwrap();

        // Get raw quantized values
        let q0 = store.get_quantized(0).unwrap();
        let q1 = store.get_quantized(1).unwrap();

        assert_eq!(q0.len(), 4);
        assert_eq!(q1.len(), 4);

        // Values should be in i8 range (always true for i8, but verify we got valid data)
        for &val in q0.iter().chain(q1.iter()) {
            // This is a type check - i8 is always in [-128, 127]
            let _ = val as i32;
        }
    }

    #[test]
    fn test_memory_savings() {
        let dir = tempdir().unwrap();
        let mut store = QuantizedVectorStore::open(dir.path(), 384).unwrap();

        let vectors = create_test_vectors(100, 384);
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();
        store.train(&refs).unwrap();
        store.append_batch(&vectors).unwrap();

        let (quantized, f32_equiv) = store.memory_stats();

        // Quantized should be approximately 4x smaller
        // (not exactly 4x due to header and params overhead)
        let ratio = f32_equiv as f64 / quantized as f64;
        assert!(ratio > 3.0, "expected >3x compression, got {}x", ratio);
    }

    #[test]
    fn test_append_without_training_fails() {
        let dir = tempdir().unwrap();
        let mut store = QuantizedVectorStore::open(dir.path(), 4).unwrap();

        let result = store.append(&[0.0, 0.0, 0.0, 0.0]);
        assert!(result.is_err());
    }

    #[test]
    fn test_dimension_mismatch() {
        let dir = tempdir().unwrap();
        let mut store = QuantizedVectorStore::open(dir.path(), 4).unwrap();

        let vectors = [vec![0.0, 0.0, 0.0, 0.0], vec![1.0, 1.0, 1.0, 1.0]];
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();
        store.train(&refs).unwrap();

        // Wrong dimension
        let result = store.append(&[0.0, 0.0, 0.0]);
        assert!(matches!(
            result,
            Err(EmbedDbError::DimensionMismatch { .. })
        ));
    }

    #[test]
    fn test_get_out_of_bounds() {
        let dir = tempdir().unwrap();
        let store = QuantizedVectorStore::open(dir.path(), 4).unwrap();

        assert!(store.get(0).is_none());
        assert!(store.get_quantized(0).is_none());
    }

    #[test]
    fn test_large_embedding() {
        let dir = tempdir().unwrap();
        let dims = 384; // Typical embedding size
        let mut store = QuantizedVectorStore::open(dir.path(), dims).unwrap();

        let vectors = create_test_vectors(50, dims);
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();
        store.train(&refs).unwrap();
        store.append_batch(&vectors).unwrap();

        assert_eq!(store.len(), 50);

        // Check roundtrip accuracy
        for (i, original) in vectors.iter().enumerate() {
            let retrieved = store.get(i).unwrap();
            let mut total_error = 0.0f32;
            for j in 0..dims {
                let error = (retrieved[j] - original[j]).abs();
                total_error += error * error;
            }
            let rmse = (total_error / dims as f32).sqrt();
            assert!(rmse < 0.01, "RMSE {} too large for vector {}", rmse, i);
        }
    }
}
