//! SIMD-accelerated vector operations
//!
//! Provides platform-specific implementations for cosine similarity:
//! - AVX2 + FMA for x86_64
//! - NEON for ARM64
//! - Scalar fallback for other platforms

mod scalar;

#[cfg(target_arch = "x86_64")]
mod avx2;

#[cfg(target_arch = "aarch64")]
mod neon;

/// Compute cosine similarity between two vectors.
///
/// Automatically selects the best available SIMD implementation at runtime.
/// Returns a value in [-1, 1] where 1 means identical direction.
#[inline]
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len(), "vectors must have same length");

    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma") {
            unsafe { avx2::cosine_avx2(a, b) }
        } else {
            scalar::cosine_scalar(a, b)
        }
    }

    #[cfg(target_arch = "aarch64")]
    {
        // NEON is always available on aarch64
        unsafe { neon::cosine_neon(a, b) }
    }

    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        scalar::cosine_scalar(a, b)
    }
}

/// Compute dot product between two vectors.
#[inline]
pub fn dot_product(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len(), "vectors must have same length");

    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma") {
            unsafe { avx2::dot_avx2(a, b) }
        } else {
            scalar::dot_scalar(a, b)
        }
    }

    #[cfg(target_arch = "aarch64")]
    {
        unsafe { neon::dot_neon(a, b) }
    }

    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        scalar::dot_scalar(a, b)
    }
}

/// Compute L2 (Euclidean) distance between two vectors.
#[inline]
pub fn l2_distance(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len(), "vectors must have same length");

    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma") {
            unsafe { avx2::l2_avx2(a, b) }
        } else {
            scalar::l2_scalar(a, b)
        }
    }

    #[cfg(target_arch = "aarch64")]
    {
        unsafe { neon::l2_neon(a, b) }
    }

    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        scalar::l2_scalar(a, b)
    }
}

/// Compute dot product between two int8 vectors.
///
/// This is used for quantized vector similarity search.
/// Returns the sum of element-wise products as i32.
#[inline]
pub fn dot_int8(a: &[i8], b: &[i8]) -> i32 {
    debug_assert_eq!(a.len(), b.len(), "vectors must have same length");

    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") {
            unsafe { avx2::dot_int8_avx2(a, b) }
        } else {
            scalar::dot_int8_scalar(a, b)
        }
    }

    #[cfg(target_arch = "aarch64")]
    {
        unsafe { neon::dot_int8_neon(a, b) }
    }

    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        scalar::dot_int8_scalar(a, b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx_eq(a: f32, b: f32, epsilon: f32) -> bool {
        (a - b).abs() < epsilon
    }

    #[test]
    fn test_cosine_identical() {
        let v = vec![1.0, 2.0, 3.0, 4.0];
        let sim = cosine_similarity(&v, &v);
        assert!(
            approx_eq(sim, 1.0, 1e-5),
            "identical vectors should have similarity 1.0, got {sim}"
        );
    }

    #[test]
    fn test_cosine_opposite() {
        let a = vec![1.0, 0.0, 0.0, 0.0];
        let b = vec![-1.0, 0.0, 0.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!(
            approx_eq(sim, -1.0, 1e-5),
            "opposite vectors should have similarity -1.0, got {sim}"
        );
    }

    #[test]
    fn test_cosine_orthogonal() {
        let a = vec![1.0, 0.0, 0.0, 0.0];
        let b = vec![0.0, 1.0, 0.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!(
            approx_eq(sim, 0.0, 1e-5),
            "orthogonal vectors should have similarity 0.0, got {sim}"
        );
    }

    #[test]
    fn test_dot_product() {
        let a = vec![1.0, 2.0, 3.0, 4.0];
        let b = vec![5.0, 6.0, 7.0, 8.0];
        let dot = dot_product(&a, &b);
        // 1*5 + 2*6 + 3*7 + 4*8 = 5 + 12 + 21 + 32 = 70
        assert!(
            approx_eq(dot, 70.0, 1e-5),
            "dot product should be 70.0, got {dot}"
        );
    }

    #[test]
    fn test_l2_distance() {
        let a = vec![0.0, 0.0, 0.0, 0.0];
        let b = vec![3.0, 4.0, 0.0, 0.0];
        let dist = l2_distance(&a, &b);
        assert!(
            approx_eq(dist, 5.0, 1e-5),
            "L2 distance should be 5.0, got {dist}"
        );
    }

    #[test]
    fn test_large_vectors() {
        // Test with 384 dimensions (typical embedding size)
        let a: Vec<f32> = (0..384).map(|i| (i as f32) * 0.01).collect();
        let b: Vec<f32> = (0..384).map(|i| (i as f32) * 0.01 + 0.5).collect();

        let sim = cosine_similarity(&a, &b);
        assert!(
            sim > 0.9,
            "similar vectors should have high similarity, got {sim}"
        );
    }

    #[test]
    fn test_dot_int8_basic() {
        let a = vec![1i8, 2, 3, 4];
        let b = vec![5i8, 6, 7, 8];
        let dot = dot_int8(&a, &b);
        // 1*5 + 2*6 + 3*7 + 4*8 = 5 + 12 + 21 + 32 = 70
        assert_eq!(dot, 70);
    }

    #[test]
    fn test_dot_int8_negative() {
        let a = vec![-1i8, -2, 3, 4];
        let b = vec![1i8, 2, -3, -4];
        let dot = dot_int8(&a, &b);
        // -1*1 + -2*2 + 3*-3 + 4*-4 = -1 + -4 + -9 + -16 = -30
        assert_eq!(dot, -30);
    }

    #[test]
    fn test_dot_int8_zeros() {
        let a = vec![0i8; 100];
        let b = vec![1i8; 100];
        let dot = dot_int8(&a, &b);
        assert_eq!(dot, 0);
    }

    #[test]
    fn test_dot_int8_extreme_values() {
        // Test with extreme i8 values
        let a = vec![127i8, -128, 127, -128];
        let b = vec![127i8, -128, -128, 127];
        let dot = dot_int8(&a, &b);
        // 127*127 + (-128)*(-128) + 127*(-128) + (-128)*127
        // = 16129 + 16384 + -16256 + -16256
        // = 1
        assert_eq!(dot, 1);
    }

    #[test]
    fn test_dot_int8_large_vector() {
        // Test with typical embedding size (384 dimensions)
        let a: Vec<i8> = (0..384)
            .map(|i| ((i % 256) as i8).wrapping_sub(64))
            .collect();
        let b: Vec<i8> = (0..384)
            .map(|i| ((i * 2 % 256) as i8).wrapping_sub(64))
            .collect();

        // Compute expected with scalar
        let expected: i32 = a
            .iter()
            .zip(b.iter())
            .map(|(&x, &y)| (x as i32) * (y as i32))
            .sum();

        let actual = dot_int8(&a, &b);
        assert_eq!(actual, expected, "SIMD result should match scalar result");
    }

    #[test]
    fn test_dot_int8_unaligned_lengths() {
        // Test various lengths that don't align to SIMD width
        for len in [1, 7, 15, 17, 31, 33, 63, 65, 100, 127] {
            let a: Vec<i8> = (0..len).map(|i| (i % 100) as i8).collect();
            let b: Vec<i8> = (0..len).map(|i| ((i + 50) % 100) as i8).collect();

            let expected: i32 = a
                .iter()
                .zip(b.iter())
                .map(|(&x, &y)| (x as i32) * (y as i32))
                .sum();

            let actual = dot_int8(&a, &b);
            assert_eq!(actual, expected, "mismatch for length {}", len);
        }
    }
}
