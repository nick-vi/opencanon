//! Scalar quantization for embedding vectors
//!
//! Provides 4x memory reduction by quantizing f32 vectors to i8 with minimal
//! accuracy loss. Uses per-dimension min-max scaling for optimal precision.
//!
//! # How it works
//!
//! For each dimension, we compute:
//! - `alpha` (scale): `(max - min) / 255`
//! - `offset`: `min`
//!
//! Quantization: `q[i] = round((x[i] - offset[i]) / alpha[i]) - 128`
//! Dequantization: `x[i] = (q[i] + 128) * alpha[i] + offset[i]`
//!
//! This maps the range [min, max] to [-128, 127].

use bytemuck::{Pod, Zeroable};

/// Scalar quantizer that maps f32 values to i8
///
/// Trained on a sample of vectors to learn per-dimension scaling parameters.
#[derive(Debug, Clone)]
pub struct ScalarQuantizer {
    /// Scale factor per dimension: (max - min) / 255
    alpha: Vec<f32>,
    /// Offset per dimension: min value
    offset: Vec<f32>,
    /// Number of dimensions
    dimensions: usize,
}

impl ScalarQuantizer {
    /// Create a new quantizer by training on sample vectors
    ///
    /// # Arguments
    /// * `vectors` - Sample vectors to learn quantization parameters from
    /// * `dimensions` - Number of dimensions in each vector
    ///
    /// # Returns
    /// A trained ScalarQuantizer that can quantize/dequantize vectors
    ///
    /// # Panics
    /// Panics if `vectors` is empty or any vector has wrong dimensions
    pub fn train(vectors: &[&[f32]], dimensions: usize) -> Self {
        assert!(!vectors.is_empty(), "cannot train on empty vector set");

        // Initialize min/max with first vector
        let mut min_vals = vec![f32::INFINITY; dimensions];
        let mut max_vals = vec![f32::NEG_INFINITY; dimensions];

        // Find min/max for each dimension
        for vector in vectors {
            assert_eq!(vector.len(), dimensions, "vector dimension mismatch");
            for (i, &val) in vector.iter().enumerate() {
                if val < min_vals[i] {
                    min_vals[i] = val;
                }
                if val > max_vals[i] {
                    max_vals[i] = val;
                }
            }
        }

        // Compute alpha (scale) and offset for each dimension
        let mut alpha = vec![0.0f32; dimensions];
        let offset = min_vals;

        for i in 0..dimensions {
            let range = max_vals[i] - offset[i];
            // Avoid division by zero for constant dimensions
            alpha[i] = if range > f32::EPSILON {
                range / 255.0
            } else {
                1.0 // Won't matter since all values are the same
            };
        }

        Self {
            alpha,
            offset,
            dimensions,
        }
    }

    /// Create a quantizer from pre-computed parameters
    ///
    /// Used when loading a quantizer from disk.
    pub fn from_params(alpha: Vec<f32>, offset: Vec<f32>) -> Self {
        assert_eq!(
            alpha.len(),
            offset.len(),
            "alpha and offset must have same length"
        );
        let dimensions = alpha.len();
        Self {
            alpha,
            offset,
            dimensions,
        }
    }

    /// Get the number of dimensions
    pub fn dimensions(&self) -> usize {
        self.dimensions
    }

    /// Get the alpha (scale) parameters
    pub fn alpha(&self) -> &[f32] {
        &self.alpha
    }

    /// Get the offset parameters
    pub fn offset(&self) -> &[f32] {
        &self.offset
    }

    /// Quantize a f32 vector to i8
    ///
    /// # Arguments
    /// * `vector` - Input f32 vector
    ///
    /// # Returns
    /// Quantized i8 vector
    ///
    /// # Panics
    /// Panics if vector has wrong dimensions
    pub fn quantize(&self, vector: &[f32]) -> Vec<i8> {
        assert_eq!(vector.len(), self.dimensions, "vector dimension mismatch");

        let mut result = vec![0i8; self.dimensions];
        for i in 0..self.dimensions {
            // Scale to [0, 255] then shift to [-128, 127]
            let scaled = (vector[i] - self.offset[i]) / self.alpha[i];
            let clamped = scaled.round().clamp(0.0, 255.0) as i32 - 128;
            result[i] = clamped as i8;
        }
        result
    }

    /// Quantize a f32 vector to i8, writing to a pre-allocated buffer
    ///
    /// # Arguments
    /// * `vector` - Input f32 vector
    /// * `out` - Output buffer for quantized values
    ///
    /// # Panics
    /// Panics if vector or output has wrong dimensions
    pub fn quantize_into(&self, vector: &[f32], out: &mut [i8]) {
        assert_eq!(vector.len(), self.dimensions, "vector dimension mismatch");
        assert_eq!(out.len(), self.dimensions, "output dimension mismatch");

        for i in 0..self.dimensions {
            let scaled = (vector[i] - self.offset[i]) / self.alpha[i];
            let clamped = scaled.round().clamp(0.0, 255.0) as i32 - 128;
            out[i] = clamped as i8;
        }
    }

    /// Dequantize an i8 vector back to f32
    ///
    /// Note: This is lossy - the original values cannot be perfectly recovered.
    ///
    /// # Arguments
    /// * `vector` - Quantized i8 vector
    ///
    /// # Returns
    /// Reconstructed f32 vector
    ///
    /// # Panics
    /// Panics if vector has wrong dimensions
    pub fn dequantize(&self, vector: &[i8]) -> Vec<f32> {
        assert_eq!(vector.len(), self.dimensions, "vector dimension mismatch");

        let mut result = vec![0.0f32; self.dimensions];
        for i in 0..self.dimensions {
            // Shift from [-128, 127] to [0, 255] then scale back
            let unshifted = (vector[i] as i32 + 128) as f32;
            result[i] = unshifted * self.alpha[i] + self.offset[i];
        }
        result
    }

    /// Dequantize an i8 vector to f32, writing to a pre-allocated buffer
    pub fn dequantize_into(&self, vector: &[i8], out: &mut [f32]) {
        assert_eq!(vector.len(), self.dimensions, "vector dimension mismatch");
        assert_eq!(out.len(), self.dimensions, "output dimension mismatch");

        for i in 0..self.dimensions {
            let unshifted = (vector[i] as i32 + 128) as f32;
            out[i] = unshifted * self.alpha[i] + self.offset[i];
        }
    }
}

/// Quantization parameters header for storage
///
/// Stores the alpha and offset arrays that define the quantization mapping.
/// This is followed by:
/// - alpha[dimensions] as f32 array
/// - offset[dimensions] as f32 array
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct QuantizationHeader {
    /// Magic number: "QVEC" in little-endian
    pub magic: u32,
    /// Version number
    pub version: u32,
    /// Number of dimensions
    pub dimensions: u32,
    /// Reserved for future use
    pub _reserved: u32,
}

/// Magic number for quantization files: "QVEC" in little-endian
pub const QUANTIZATION_MAGIC: u32 = 0x43455651;

/// Current version of quantization format
pub const QUANTIZATION_VERSION: u32 = 1;

impl QuantizationHeader {
    /// Create a new quantization header
    pub fn new(dimensions: u32) -> Self {
        Self {
            magic: QUANTIZATION_MAGIC,
            version: QUANTIZATION_VERSION,
            dimensions,
            _reserved: 0,
        }
    }

    /// Validate the header
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.magic != QUANTIZATION_MAGIC {
            return Err("invalid magic number");
        }
        if self.version != QUANTIZATION_VERSION {
            return Err("format version mismatch");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_train_basic() {
        let vectors: Vec<Vec<f32>> = vec![
            vec![0.0, 0.0, 0.0, 0.0],
            vec![1.0, 2.0, 3.0, 4.0],
            vec![0.5, 1.0, 1.5, 2.0],
        ];
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        let quantizer = ScalarQuantizer::train(&refs, 4);

        assert_eq!(quantizer.dimensions(), 4);

        // Offset should be min values
        assert!((quantizer.offset()[0] - 0.0).abs() < f32::EPSILON);
        assert!((quantizer.offset()[1] - 0.0).abs() < f32::EPSILON);
        assert!((quantizer.offset()[2] - 0.0).abs() < f32::EPSILON);
        assert!((quantizer.offset()[3] - 0.0).abs() < f32::EPSILON);

        // Alpha should be range / 255
        assert!((quantizer.alpha()[0] - 1.0 / 255.0).abs() < 1e-6);
        assert!((quantizer.alpha()[1] - 2.0 / 255.0).abs() < 1e-6);
        assert!((quantizer.alpha()[2] - 3.0 / 255.0).abs() < 1e-6);
        assert!((quantizer.alpha()[3] - 4.0 / 255.0).abs() < 1e-6);
    }

    #[test]
    fn test_quantize_dequantize_roundtrip() {
        let vectors: Vec<Vec<f32>> = vec![
            vec![0.0, -1.0, 0.5, 1.0],
            vec![1.0, 1.0, 1.0, 2.0],
            vec![0.5, 0.0, 0.75, 1.5],
        ];
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        let quantizer = ScalarQuantizer::train(&refs, 4);

        for original in &vectors {
            let quantized = quantizer.quantize(original);
            let reconstructed = quantizer.dequantize(&quantized);

            // Check that roundtrip error is small (< 1% of range)
            for i in 0..4 {
                let error = (original[i] - reconstructed[i]).abs();
                let range = quantizer.alpha()[i] * 255.0;
                let relative_error = error / range.max(f32::EPSILON);
                assert!(
                    relative_error < 0.01,
                    "dim {}: error {} > 1% of range {} (original: {}, reconstructed: {})",
                    i,
                    error,
                    range,
                    original[i],
                    reconstructed[i]
                );
            }
        }
    }

    #[test]
    fn test_quantize_zero_vector() {
        let vectors: Vec<Vec<f32>> = vec![vec![0.0, 0.0, 0.0, 0.0], vec![1.0, 1.0, 1.0, 1.0]];
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        let quantizer = ScalarQuantizer::train(&refs, 4);

        let zero = vec![0.0, 0.0, 0.0, 0.0];
        let quantized = quantizer.quantize(&zero);

        // Zero vector should quantize to -128 (min value after shift)
        for &q in &quantized {
            assert_eq!(q, -128);
        }

        // Dequantize should give back ~0
        let reconstructed = quantizer.dequantize(&quantized);
        for val in reconstructed {
            assert!(val.abs() < 0.01, "expected ~0, got {}", val);
        }
    }

    #[test]
    fn test_quantize_constant_dimension() {
        // All values in dimension 0 are the same
        let vectors: Vec<Vec<f32>> = vec![vec![5.0, 0.0], vec![5.0, 1.0], vec![5.0, 2.0]];
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        let quantizer = ScalarQuantizer::train(&refs, 2);

        // Should not crash and should handle gracefully
        let test = vec![5.0, 1.0];
        let quantized = quantizer.quantize(&test);
        let reconstructed = quantizer.dequantize(&quantized);

        // The constant dimension should be preserved
        assert!((reconstructed[0] - 5.0).abs() < 0.1);
    }

    #[test]
    fn test_quantize_large_values() {
        let vectors: Vec<Vec<f32>> = vec![vec![-1000.0, 0.0], vec![1000.0, 100.0]];
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        let quantizer = ScalarQuantizer::train(&refs, 2);

        let test = vec![0.0, 50.0];
        let quantized = quantizer.quantize(&test);
        let reconstructed = quantizer.dequantize(&quantized);

        // Check reasonable accuracy given large range
        let error0 = (reconstructed[0] - 0.0).abs();
        let error1 = (reconstructed[1] - 50.0).abs();

        // Error should be < 1% of range
        assert!(error0 < 20.0, "error {} too large", error0);
        assert!(error1 < 1.0, "error {} too large", error1);
    }

    #[test]
    fn test_quantize_negative_values() {
        let vectors: Vec<Vec<f32>> = vec![
            vec![-1.0, -2.0, -3.0],
            vec![-0.5, -1.0, -1.5],
            vec![0.0, 0.0, 0.0],
        ];
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        let quantizer = ScalarQuantizer::train(&refs, 3);

        for original in &vectors {
            let quantized = quantizer.quantize(original);
            let reconstructed = quantizer.dequantize(&quantized);

            for i in 0..3 {
                let error = (original[i] - reconstructed[i]).abs();
                assert!(error < 0.02, "error {} too large for dim {}", error, i);
            }
        }
    }

    #[test]
    fn test_quantize_into() {
        let vectors: Vec<Vec<f32>> = vec![vec![0.0, 0.0], vec![1.0, 1.0]];
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        let quantizer = ScalarQuantizer::train(&refs, 2);

        let input = vec![0.5, 0.5];
        let mut output = vec![0i8; 2];

        quantizer.quantize_into(&input, &mut output);

        let expected = quantizer.quantize(&input);
        assert_eq!(output, expected);
    }

    #[test]
    fn test_dequantize_into() {
        let vectors: Vec<Vec<f32>> = vec![vec![0.0, 0.0], vec![1.0, 1.0]];
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        let quantizer = ScalarQuantizer::train(&refs, 2);

        let quantized = vec![0i8, 64i8];
        let mut output = vec![0.0f32; 2];

        quantizer.dequantize_into(&quantized, &mut output);

        let expected = quantizer.dequantize(&quantized);
        assert_eq!(output, expected);
    }

    #[test]
    fn test_from_params() {
        let alpha = vec![0.01, 0.02, 0.03];
        let offset = vec![1.0, 2.0, 3.0];

        let quantizer = ScalarQuantizer::from_params(alpha.clone(), offset.clone());

        assert_eq!(quantizer.dimensions(), 3);
        assert_eq!(quantizer.alpha(), &alpha);
        assert_eq!(quantizer.offset(), &offset);
    }

    #[test]
    fn test_header_validation() {
        let header = QuantizationHeader::new(384);
        assert!(header.validate().is_ok());

        let bad_magic = QuantizationHeader {
            magic: 0xDEADBEEF,
            ..header
        };
        assert!(bad_magic.validate().is_err());

        let bad_version = QuantizationHeader {
            version: 999,
            ..header
        };
        assert!(bad_version.validate().is_err());

        let obsolete_version = QuantizationHeader {
            version: 0,
            ..header
        };
        assert!(obsolete_version.validate().is_err());
    }

    #[test]
    #[should_panic(expected = "cannot train on empty vector set")]
    fn test_train_empty_panics() {
        let empty: Vec<&[f32]> = vec![];
        ScalarQuantizer::train(&empty, 4);
    }

    #[test]
    #[should_panic(expected = "vector dimension mismatch")]
    fn test_quantize_wrong_dims_panics() {
        let vectors: Vec<Vec<f32>> = vec![vec![0.0, 1.0]];
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        let quantizer = ScalarQuantizer::train(&refs, 2);
        quantizer.quantize(&[0.0, 0.5, 1.0]); // Wrong dimensions
    }

    #[test]
    fn test_embedding_like_vectors() {
        // Simulate typical embedding values (small floats centered around 0)
        let mut vectors = Vec::new();
        for i in 0..100 {
            let mut v = vec![0.0f32; 384];
            for (j, item) in v.iter_mut().enumerate().take(384) {
                // Typical embedding values: [-0.5, 0.5]
                *item = ((i * 17 + j * 31) % 1000) as f32 / 1000.0 - 0.5;
            }
            vectors.push(v);
        }
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        let quantizer = ScalarQuantizer::train(&refs, 384);

        // Check roundtrip accuracy
        for original in vectors.iter().take(10) {
            let quantized = quantizer.quantize(original);
            let reconstructed = quantizer.dequantize(&quantized);

            let mut total_error = 0.0f32;
            for i in 0..384 {
                let error = (original[i] - reconstructed[i]).abs();
                total_error += error * error;
            }
            let rmse = (total_error / 384.0).sqrt();

            // RMSE should be very small for typical embeddings
            assert!(rmse < 0.005, "RMSE {} too large", rmse);
        }
    }
}
