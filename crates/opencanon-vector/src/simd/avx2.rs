//! AVX2 + FMA SIMD implementations for x86_64
//!
//! Processes 8 floats per iteration using 256-bit registers.
//! For int8 operations, processes 32 bytes at a time using VPMADDUBSW.

#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::*;

/// Horizontal sum of 256-bit register
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
#[inline]
unsafe fn hsum256(v: __m256) -> f32 {
    // [a0, a1, a2, a3, a4, a5, a6, a7]
    // vhadd: [a0+a1, a2+a3, a4+a5, a6+a7, a0+a1, a2+a3, a4+a5, a6+a7] (not quite, but concept)
    let hi = _mm256_extractf128_ps(v, 1); // [a4, a5, a6, a7]
    let lo = _mm256_castps256_ps128(v); // [a0, a1, a2, a3]
    let sum128 = _mm_add_ps(lo, hi); // [a0+a4, a1+a5, a2+a6, a3+a7]
    let hi64 = _mm_movehl_ps(sum128, sum128); // [a2+a6, a3+a7, ?, ?]
    let sum64 = _mm_add_ps(sum128, hi64); // [a0+a4+a2+a6, a1+a5+a3+a7, ?, ?]
    let hi32 = _mm_shuffle_ps(sum64, sum64, 1); // [a1+a5+a3+a7, ?, ?, ?]
    let sum32 = _mm_add_ss(sum64, hi32);
    _mm_cvtss_f32(sum32)
}

/// AVX2 + FMA cosine similarity
///
/// # Safety
/// Requires AVX2 and FMA CPU features.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2", enable = "fma")]
pub unsafe fn cosine_avx2(a: &[f32], b: &[f32]) -> f32 {
    let len = a.len();
    let chunks = len / 8;
    let remainder = len % 8;

    let mut dot = _mm256_setzero_ps();
    let mut norm_a = _mm256_setzero_ps();
    let mut norm_b = _mm256_setzero_ps();

    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();

    // Process 8 floats at a time
    for i in 0..chunks {
        let offset = i * 8;
        let va = _mm256_loadu_ps(a_ptr.add(offset));
        let vb = _mm256_loadu_ps(b_ptr.add(offset));

        dot = _mm256_fmadd_ps(va, vb, dot);
        norm_a = _mm256_fmadd_ps(va, va, norm_a);
        norm_b = _mm256_fmadd_ps(vb, vb, norm_b);
    }

    let mut dot_sum = hsum256(dot);
    let mut norm_a_sum = hsum256(norm_a);
    let mut norm_b_sum = hsum256(norm_b);

    // Handle remainder
    let base = chunks * 8;
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

/// AVX2 + FMA dot product
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2", enable = "fma")]
pub unsafe fn dot_avx2(a: &[f32], b: &[f32]) -> f32 {
    let len = a.len();
    let chunks = len / 8;
    let remainder = len % 8;

    let mut acc = _mm256_setzero_ps();

    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();

    for i in 0..chunks {
        let offset = i * 8;
        let va = _mm256_loadu_ps(a_ptr.add(offset));
        let vb = _mm256_loadu_ps(b_ptr.add(offset));
        acc = _mm256_fmadd_ps(va, vb, acc);
    }

    let mut sum = hsum256(acc);

    let base = chunks * 8;
    for i in 0..remainder {
        sum += *a_ptr.add(base + i) * *b_ptr.add(base + i);
    }

    sum
}

/// AVX2 L2 distance
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2", enable = "fma")]
pub unsafe fn l2_avx2(a: &[f32], b: &[f32]) -> f32 {
    let len = a.len();
    let chunks = len / 8;
    let remainder = len % 8;

    let mut acc = _mm256_setzero_ps();

    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();

    for i in 0..chunks {
        let offset = i * 8;
        let va = _mm256_loadu_ps(a_ptr.add(offset));
        let vb = _mm256_loadu_ps(b_ptr.add(offset));
        let diff = _mm256_sub_ps(va, vb);
        acc = _mm256_fmadd_ps(diff, diff, acc);
    }

    let mut sum = hsum256(acc);

    let base = chunks * 8;
    for i in 0..remainder {
        let diff = *a_ptr.add(base + i) - *b_ptr.add(base + i);
        sum += diff * diff;
    }

    sum.sqrt()
}

/// Horizontal sum of 256-bit integer register (4 x i32)
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
#[inline]
unsafe fn hsum256_epi32(v: __m256i) -> i32 {
    // Extract high and low 128-bit lanes
    let hi = _mm256_extracti128_si256(v, 1);
    let lo = _mm256_castsi256_si128(v);

    // Add the two 128-bit vectors
    let sum128 = _mm_add_epi32(lo, hi);

    // Horizontal add within 128-bit vector
    // sum128 = [a, b, c, d]
    let hi64 = _mm_unpackhi_epi64(sum128, sum128); // [c, d, c, d]
    let sum64 = _mm_add_epi32(sum128, hi64); // [a+c, b+d, ?, ?]
    let hi32 = _mm_shuffle_epi32(sum64, 1); // [b+d, ?, ?, ?]
    let sum32 = _mm_add_epi32(sum64, hi32); // [a+b+c+d, ?, ?, ?]

    _mm_cvtsi128_si32(sum32)
}

/// AVX2 int8 dot product
///
/// Computes dot product of two i8 vectors using VPMADDUBSW and VPMADDWD.
/// This is approximately 4x faster than f32 dot product due to higher throughput.
///
/// # Algorithm
/// 1. Load 32 bytes from each vector
/// 2. Use VPMADDUBSW to multiply pairs and add to i16
/// 3. Use VPMADDWD to further reduce i16 to i32
/// 4. Accumulate i32 sums
///
/// # Safety
/// Requires AVX2 CPU feature.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
pub unsafe fn dot_int8_avx2(a: &[i8], b: &[i8]) -> i32 {
    debug_assert_eq!(a.len(), b.len(), "vectors must have same length");

    let len = a.len();
    let chunks = len / 32;
    let remainder = len % 32;

    let mut acc = _mm256_setzero_si256();

    let a_ptr = a.as_ptr() as *const __m256i;
    let b_ptr = b.as_ptr() as *const __m256i;

    // Process 32 bytes at a time
    for i in 0..chunks {
        let va = _mm256_loadu_si256(a_ptr.add(i));
        let vb = _mm256_loadu_si256(b_ptr.add(i));

        // Split into low and high bytes for signed multiplication
        // We need to handle signed i8 carefully
        //
        // Strategy: Use _mm256_maddubs_epi16 which treats first operand as unsigned
        // and second as signed. We'll compute: a*b = (a+128-128)*b = (a+128)*b - 128*b
        // where (a+128) is unsigned [0,255] for signed a in [-128,127]

        // Convert signed a to unsigned by adding 128
        let offset = _mm256_set1_epi8(-128i8);
        let va_unsigned = _mm256_sub_epi8(va, offset); // a + 128 as unsigned

        // Multiply unsigned a with signed b, producing 16 pairs of i16
        // maddubs: (a[2i]*b[2i] + a[2i+1]*b[2i+1]) for each pair
        let prod = _mm256_maddubs_epi16(va_unsigned, vb);

        // We need to subtract the correction: 128 * sum(b)
        // Sum b values: interpret as i8, sum pairs to i16
        let ones = _mm256_set1_epi8(1);
        let b_sum_pairs = _mm256_maddubs_epi16(ones, vb); // Note: ones is unsigned 1

        // Correction: 128 * b_sum = b_sum << 7
        let correction = _mm256_slli_epi16(b_sum_pairs, 7);

        // Subtract correction from product
        let corrected = _mm256_sub_epi16(prod, correction);

        // Reduce 16xi16 to 8xi32 using madd with 1s
        let ones_16 = _mm256_set1_epi16(1);
        let sum32 = _mm256_madd_epi16(corrected, ones_16);

        acc = _mm256_add_epi32(acc, sum32);
    }

    let mut sum = hsum256_epi32(acc);

    // Handle remainder with scalar code
    let base = chunks * 32;
    for i in 0..remainder {
        sum += (*a.as_ptr().add(base + i) as i32) * (*b.as_ptr().add(base + i) as i32);
    }

    sum
}
