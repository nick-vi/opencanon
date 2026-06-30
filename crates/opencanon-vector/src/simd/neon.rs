//! NEON SIMD implementations for ARM64
//!
//! Processes 4 floats per iteration using 128-bit registers.
//! For int8 operations, processes 16 bytes at a time.
//! NEON is always available on aarch64.

#[cfg(target_arch = "aarch64")]
use std::arch::aarch64::*;

/// NEON cosine similarity
///
/// # Safety
/// Requires aarch64 with NEON (always available on aarch64).
#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
pub unsafe fn cosine_neon(a: &[f32], b: &[f32]) -> f32 {
    let len = a.len();
    let chunks = len / 4;
    let remainder = len % 4;

    let mut dot = vdupq_n_f32(0.0);
    let mut norm_a = vdupq_n_f32(0.0);
    let mut norm_b = vdupq_n_f32(0.0);

    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();

    // Process 4 floats at a time
    for i in 0..chunks {
        let offset = i * 4;
        let va = vld1q_f32(a_ptr.add(offset));
        let vb = vld1q_f32(b_ptr.add(offset));

        dot = vfmaq_f32(dot, va, vb);
        norm_a = vfmaq_f32(norm_a, va, va);
        norm_b = vfmaq_f32(norm_b, vb, vb);
    }

    // Horizontal sum
    let mut dot_sum = vaddvq_f32(dot);
    let mut norm_a_sum = vaddvq_f32(norm_a);
    let mut norm_b_sum = vaddvq_f32(norm_b);

    // Handle remainder
    let base = chunks * 4;
    for i in 0..remainder {
        let av = *a_ptr.add(base + i);
        let bv = *b_ptr.add(base + i);
        dot_sum += av * bv;
        norm_a_sum += av * av;
        norm_b_sum += bv * bv;
    }

    let norm = (norm_a_sum * norm_b_sum).sqrt();
    if norm == 0.0 {
        0.0
    } else {
        dot_sum / norm
    }
}

/// NEON dot product
#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
pub unsafe fn dot_neon(a: &[f32], b: &[f32]) -> f32 {
    let len = a.len();
    let chunks = len / 4;
    let remainder = len % 4;

    let mut acc = vdupq_n_f32(0.0);

    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();

    for i in 0..chunks {
        let offset = i * 4;
        let va = vld1q_f32(a_ptr.add(offset));
        let vb = vld1q_f32(b_ptr.add(offset));
        acc = vfmaq_f32(acc, va, vb);
    }

    let mut sum = vaddvq_f32(acc);

    let base = chunks * 4;
    for i in 0..remainder {
        sum += *a_ptr.add(base + i) * *b_ptr.add(base + i);
    }

    sum
}

/// NEON L2 distance
#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
pub unsafe fn l2_neon(a: &[f32], b: &[f32]) -> f32 {
    let len = a.len();
    let chunks = len / 4;
    let remainder = len % 4;

    let mut acc = vdupq_n_f32(0.0);

    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();

    for i in 0..chunks {
        let offset = i * 4;
        let va = vld1q_f32(a_ptr.add(offset));
        let vb = vld1q_f32(b_ptr.add(offset));
        let diff = vsubq_f32(va, vb);
        acc = vfmaq_f32(acc, diff, diff);
    }

    let mut sum = vaddvq_f32(acc);

    let base = chunks * 4;
    for i in 0..remainder {
        let diff = *a_ptr.add(base + i) - *b_ptr.add(base + i);
        sum += diff * diff;
    }

    sum.sqrt()
}

/// NEON int8 dot product
///
/// Computes dot product of two i8 vectors using NEON SDOT instruction
/// or a fallback using multiply-accumulate operations.
///
/// Processes 16 bytes at a time.
///
/// # Safety
/// Requires aarch64 with NEON (always available on aarch64).
#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
pub unsafe fn dot_int8_neon(a: &[i8], b: &[i8]) -> i32 {
    debug_assert_eq!(a.len(), b.len(), "vectors must have same length");

    let len = a.len();
    let chunks = len / 16;
    let remainder = len % 16;

    // Accumulator for 4xi32
    let mut acc = vdupq_n_s32(0);

    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();

    // Process 16 bytes at a time
    for i in 0..chunks {
        let offset = i * 16;

        // Load 16 bytes from each vector
        let va = vld1q_s8(a_ptr.add(offset));
        let vb = vld1q_s8(b_ptr.add(offset));

        // Split into low and high 8 bytes
        let va_lo = vget_low_s8(va);
        let va_hi = vget_high_s8(va);
        let vb_lo = vget_low_s8(vb);
        let vb_hi = vget_high_s8(vb);

        // Widen to i16 and multiply
        let prod_lo = vmull_s8(va_lo, vb_lo); // 8xi16
        let prod_hi = vmull_s8(va_hi, vb_hi); // 8xi16

        // Pairwise add to i32
        let sum_lo = vpaddlq_s16(prod_lo); // 4xi32
        let sum_hi = vpaddlq_s16(prod_hi); // 4xi32

        // Accumulate
        acc = vaddq_s32(acc, sum_lo);
        acc = vaddq_s32(acc, sum_hi);
    }

    // Horizontal sum of 4xi32
    let mut sum = vaddvq_s32(acc);

    // Handle remainder with scalar code
    let base = chunks * 16;
    for i in 0..remainder {
        sum += (*a_ptr.add(base + i) as i32) * (*b_ptr.add(base + i) as i32);
    }

    sum
}
