//! Scalar (non-SIMD) implementations
//!
//! Used as fallback when SIMD is not available.

/// Scalar cosine similarity
#[inline]
#[allow(dead_code)]
pub fn cosine_scalar(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;

    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }

    let norm = (norm_a * norm_b).sqrt();
    if norm == 0.0 {
        0.0
    } else {
        dot / norm
    }
}

/// Scalar dot product
#[inline]
#[allow(dead_code)]
pub fn dot_scalar(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// Scalar L2 distance
#[inline]
#[allow(dead_code)]
pub fn l2_scalar(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b.iter())
        .map(|(x, y)| {
            let diff = x - y;
            diff * diff
        })
        .sum::<f32>()
        .sqrt()
}

/// Scalar int8 dot product
#[inline]
#[allow(dead_code)]
pub fn dot_int8_scalar(a: &[i8], b: &[i8]) -> i32 {
    a.iter()
        .zip(b.iter())
        .map(|(&x, &y)| (x as i32) * (y as i32))
        .sum()
}
