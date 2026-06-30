//! Two-stage quantized search
//!
//! Provides approximate nearest neighbor search using quantized vectors:
//! 1. First stage: Fast search using int8 dot product
//! 2. Second stage: Rescore top candidates using original f32 vectors
//!
//! This gives approximately 4x memory reduction with minimal accuracy loss.

use crate::simd::{cosine_similarity, dot_int8};
use crate::store::{MmapVectorStore, QuantizedVectorStore};
use crate::Match;

/// Two-stage quantized search engine
///
/// Stores both quantized (int8) and original (f32) vectors.
/// Uses quantized vectors for fast initial search, then rescores
/// with original vectors for accuracy.
pub struct QuantizedSearchEngine {
    /// Quantized vector store (int8)
    quantized_store: QuantizedVectorStore,
    /// Original vector store (f32) for rescoring
    f32_store: MmapVectorStore,
    /// Rescore factor: search k * rescore_factor candidates, then rescore
    rescore_factor: usize,
}

impl QuantizedSearchEngine {
    /// Create a new quantized search engine
    ///
    /// # Arguments
    /// * `quantized_store` - Trained quantized vector store
    /// * `f32_store` - Original f32 vector store
    /// * `rescore_factor` - Multiply k by this to get candidate set size (default: 4)
    pub fn new(
        quantized_store: QuantizedVectorStore,
        f32_store: MmapVectorStore,
        rescore_factor: usize,
    ) -> Self {
        Self {
            quantized_store,
            f32_store,
            rescore_factor,
        }
    }

    /// Search for nearest neighbors using two-stage quantized search
    ///
    /// 1. Quantize the query vector
    /// 2. Find top k * rescore_factor candidates using int8 dot product
    /// 3. Rescore candidates using original f32 cosine similarity
    /// 4. Return top k results
    ///
    /// # Arguments
    /// * `query` - Query vector (f32)
    /// * `k` - Number of results to return
    /// * `candidate_ids` - Optional list of IDs to search (for filtered search)
    ///
    /// # Returns
    /// Top k matches sorted by score (highest first)
    pub fn search(&self, query: &[f32], k: usize, candidate_ids: Option<&[usize]>) -> Vec<Match> {
        let quantizer = match self.quantized_store.quantizer() {
            Some(q) => q,
            None => return Vec::new(), // Not trained yet
        };

        // Quantize the query
        let query_quantized = quantizer.quantize(query);

        // Determine which IDs to search
        let search_ids: Vec<usize> = match candidate_ids {
            Some(ids) => ids.to_vec(),
            None => (0..self.quantized_store.len()).collect(),
        };

        if search_ids.is_empty() {
            return Vec::new();
        }

        // First stage: Find candidates using int8 dot product
        let num_candidates = (k * self.rescore_factor).min(search_ids.len());
        let mut candidates: Vec<(usize, i32)> = search_ids
            .iter()
            .filter_map(|&id| {
                let vec = self.quantized_store.get_quantized(id)?;
                let score = dot_int8(&query_quantized, vec);
                Some((id, score))
            })
            .collect();

        // Sort by int8 score (higher is better for dot product)
        candidates.sort_unstable_by_key(|item| std::cmp::Reverse(item.1));
        candidates.truncate(num_candidates);

        // Second stage: Rescore with f32 cosine similarity
        let mut results: Vec<Match> = candidates
            .iter()
            .filter_map(|&(id, _)| {
                let vec = self.f32_store.get(id)?;
                let score = cosine_similarity(query, vec);
                Some(Match { id, score })
            })
            .collect();

        // Sort by f32 score and return top k
        results.sort_unstable_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        results.truncate(k);

        results
    }

    /// Brute-force search for comparison/testing
    ///
    /// Uses only f32 cosine similarity, no quantization.
    /// Useful for measuring accuracy of quantized search.
    #[allow(dead_code)]
    pub fn search_exact(&self, query: &[f32], k: usize) -> Vec<Match> {
        let mut results: Vec<Match> = (0..self.f32_store.len())
            .filter_map(|id| {
                let vec = self.f32_store.get(id)?;
                let score = cosine_similarity(query, vec);
                Some(Match { id, score })
            })
            .collect();

        results.sort_unstable_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        results.truncate(k);

        results
    }

    /// Calculate recall@k compared to exact search
    ///
    /// Returns the fraction of exact top-k results found in quantized top-k.
    #[allow(dead_code)]
    pub fn measure_recall(&self, query: &[f32], k: usize) -> f32 {
        let exact = self.search_exact(query, k);
        let quantized = self.search(query, k, None);

        if exact.is_empty() {
            return 1.0;
        }

        let exact_ids: std::collections::HashSet<usize> = exact.iter().map(|m| m.id).collect();
        let found = quantized
            .iter()
            .filter(|m| exact_ids.contains(&m.id))
            .count();

        found as f32 / exact.len() as f32
    }

    /// Get the quantized store
    pub fn quantized_store(&self) -> &QuantizedVectorStore {
        &self.quantized_store
    }

    /// Get the f32 store
    pub fn f32_store(&self) -> &MmapVectorStore {
        &self.f32_store
    }
}

/// Standalone function to compute quantized similarity
///
/// Useful for custom search implementations.
pub fn quantized_similarity(query_quantized: &[i8], candidate_quantized: &[i8]) -> i32 {
    dot_int8(query_quantized, candidate_quantized)
}

/// Compute approximate cosine similarity from quantized vectors
///
/// The int8 dot product approximates cosine similarity when vectors
/// are normalized and quantization is trained on representative data.
pub fn approximate_cosine_from_int8(dot: i32, dimensions: usize) -> f32 {
    // For normalized vectors quantized to [-128, 127], the maximum
    // dot product is approximately 128^2 * dimensions
    let max_dot = 128.0 * 128.0 * dimensions as f32;

    // Scale to [0, 1] range (assuming positive correlation)
    ((dot as f32 / max_dot) + 1.0) / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn create_test_data(count: usize, dims: usize) -> Vec<Vec<f32>> {
        (0..count)
            .map(|i| {
                let mut v: Vec<f32> = (0..dims)
                    .map(|j| ((i * 17 + j * 31) % 100) as f32 / 100.0 - 0.5)
                    .collect();
                // Normalize
                let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
                if norm > 0.0 {
                    for x in &mut v {
                        *x /= norm;
                    }
                }
                v
            })
            .collect()
    }

    #[test]
    fn test_quantized_search_basic() {
        let dir = tempdir().unwrap();
        let dims = 64;

        // Create stores
        let mut q_store = QuantizedVectorStore::open(dir.path(), dims).unwrap();
        let mut f32_store = MmapVectorStore::open(dir.path(), dims).unwrap();

        // Create test data
        let vectors = create_test_data(100, dims);
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        // Train quantizer
        q_store.train(&refs).unwrap();

        // Insert vectors
        for v in &vectors {
            f32_store.append(v).unwrap();
            q_store.append(v).unwrap();
        }

        // Create search engine
        let engine = QuantizedSearchEngine::new(q_store, f32_store, 4);

        // Search
        let query = &vectors[50];
        let results = engine.search(query, 10, None);

        assert_eq!(results.len(), 10);

        // First result should be the exact match (or very close)
        assert_eq!(results[0].id, 50, "Expected exact match for query vector");
        assert!(
            results[0].score > 0.99,
            "Expected score ~1.0, got {}",
            results[0].score
        );
    }

    #[test]
    fn test_recall_vs_exact() {
        let dir = tempdir().unwrap();
        let dims = 64;

        let mut q_store = QuantizedVectorStore::open(dir.path(), dims).unwrap();
        let mut f32_store = MmapVectorStore::open(dir.path(), dims).unwrap();

        let vectors = create_test_data(200, dims);
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        q_store.train(&refs).unwrap();

        for v in &vectors {
            f32_store.append(v).unwrap();
            q_store.append(v).unwrap();
        }

        let engine = QuantizedSearchEngine::new(q_store, f32_store, 4);

        // Measure recall for several queries
        let mut total_recall = 0.0;
        for i in [0, 50, 100, 150, 199] {
            let recall = engine.measure_recall(&vectors[i], 10);
            total_recall += recall;
        }

        let avg_recall = total_recall / 5.0;
        assert!(
            avg_recall > 0.8,
            "Expected recall > 0.8, got {}",
            avg_recall
        );
    }

    #[test]
    fn test_filtered_search() {
        let dir = tempdir().unwrap();
        let dims = 32;

        let mut q_store = QuantizedVectorStore::open(dir.path(), dims).unwrap();
        let mut f32_store = MmapVectorStore::open(dir.path(), dims).unwrap();

        let vectors = create_test_data(50, dims);
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        q_store.train(&refs).unwrap();

        for v in &vectors {
            f32_store.append(v).unwrap();
            q_store.append(v).unwrap();
        }

        let engine = QuantizedSearchEngine::new(q_store, f32_store, 4);

        // Search only in subset of IDs
        let allowed_ids: Vec<usize> = (10..30).collect();
        let query = &vectors[20];
        let results = engine.search(query, 5, Some(&allowed_ids));

        assert_eq!(results.len(), 5);

        // All results should be in allowed range
        for r in &results {
            assert!(
                r.id >= 10 && r.id < 30,
                "Result id {} not in allowed range",
                r.id
            );
        }

        // First result should be exact match
        assert_eq!(results[0].id, 20);
    }

    #[test]
    fn test_empty_store() {
        let dir = tempdir().unwrap();
        let dims = 32;

        let q_store = QuantizedVectorStore::open(dir.path(), dims).unwrap();
        let f32_store = MmapVectorStore::open(dir.path(), dims).unwrap();

        let engine = QuantizedSearchEngine::new(q_store, f32_store, 4);

        let query = vec![0.0; dims];
        let results = engine.search(&query, 10, None);

        assert!(results.is_empty());
    }

    #[test]
    fn test_rescore_factor() {
        let dir = tempdir().unwrap();
        let dims = 32;

        let mut q_store = QuantizedVectorStore::open(dir.path(), dims).unwrap();
        let mut f32_store = MmapVectorStore::open(dir.path(), dims).unwrap();

        let vectors = create_test_data(100, dims);
        let refs: Vec<&[f32]> = vectors.iter().map(|v| v.as_slice()).collect();

        q_store.train(&refs).unwrap();

        for v in &vectors {
            f32_store.append(v).unwrap();
            q_store.append(v).unwrap();
        }

        // Higher rescore factor should give better recall
        let engine_low = QuantizedSearchEngine::new(
            QuantizedVectorStore::open(dir.path(), dims).unwrap(),
            MmapVectorStore::open(dir.path(), dims).unwrap(),
            2,
        );
        let engine_high = QuantizedSearchEngine::new(
            QuantizedVectorStore::open(dir.path(), dims).unwrap(),
            MmapVectorStore::open(dir.path(), dims).unwrap(),
            8,
        );

        let query = &vectors[50];
        let k = 10;

        // Both should return results
        let results_low = engine_low.search(query, k, None);
        let results_high = engine_high.search(query, k, None);

        assert_eq!(results_low.len(), k);
        assert_eq!(results_high.len(), k);
    }

    #[test]
    fn test_approximate_cosine() {
        // Test the approximate cosine conversion
        let dims = 100;

        // Maximum possible dot product (all 127s)
        let max_dot = 127 * 127 * dims as i32;
        let approx = approximate_cosine_from_int8(max_dot, dims);
        assert!(approx > 0.9, "Expected high similarity for max dot");

        // Zero dot product
        let zero_approx = approximate_cosine_from_int8(0, dims);
        assert!(
            (zero_approx - 0.5).abs() < 0.1,
            "Expected ~0.5 for zero dot"
        );
    }
}
