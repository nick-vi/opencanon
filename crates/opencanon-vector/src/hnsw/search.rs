//! HNSW search algorithms

use super::index::{Candidate, HnswIndex, MinCandidate};
use crate::store::MmapVectorStore;
use crate::Match;
use roaring::RoaringBitmap;
use std::collections::{BinaryHeap, HashSet};

/// Search for k nearest neighbors
pub fn search(
    index: &HnswIndex,
    query: &[f32],
    k: usize,
    ef: usize,
    store: &MmapVectorStore,
    deleted: &RoaringBitmap,
) -> Vec<Match> {
    if index.is_empty() {
        return Vec::new();
    }

    let entry_point = match index.entry_point() {
        Some(ep) => ep,
        None => return Vec::new(),
    };

    // Use ef or k, whichever is larger
    let ef = ef.max(k);

    // Phase 1: Greedy descent through upper layers
    let mut current = entry_point;
    let max_level = index.max_level();

    for lc in (1..=max_level).rev() {
        current = greedy_search_layer(index, query, current, lc, store);
    }

    // Phase 2: Beam search at layer 0
    let candidates = search_layer_0(index, query, current, ef, store, deleted);

    // Return top k results
    candidates
        .into_iter()
        .take(k)
        .map(|c| Match {
            id: c.id,
            score: 1.0 - c.distance, // Convert distance back to similarity
        })
        .collect()
}

/// Search with a filter on allowed IDs
pub fn search_filtered(
    index: &HnswIndex,
    query: &[f32],
    k: usize,
    ef: usize,
    store: &MmapVectorStore,
    allowed_ids: &[usize],
) -> Vec<Match> {
    if index.is_empty() || allowed_ids.is_empty() {
        return Vec::new();
    }

    let allowed_set: HashSet<usize> = allowed_ids.iter().copied().collect();

    let entry_point = match index.entry_point() {
        Some(ep) => ep,
        None => return Vec::new(),
    };

    let ef = ef.max(k);

    // Phase 1: Greedy descent
    let mut current = entry_point;
    let max_level = index.max_level();

    for lc in (1..=max_level).rev() {
        current = greedy_search_layer(index, query, current, lc, store);
    }

    // Phase 2: Filtered beam search at layer 0
    let candidates = search_layer_0_filtered(index, query, current, ef, store, &allowed_set);

    candidates
        .into_iter()
        .take(k)
        .map(|c| Match {
            id: c.id,
            score: 1.0 - c.distance,
        })
        .collect()
}

/// Greedy search to find closest node at a layer
fn greedy_search_layer(
    index: &HnswIndex,
    query: &[f32],
    entry: usize,
    level: usize,
    store: &MmapVectorStore,
) -> usize {
    let mut current = entry;
    let mut current_dist = distance(index, query, current, store);

    loop {
        let mut changed = false;

        if let Some(neighbors) = index.neighbors(current, level) {
            for &neighbor in neighbors {
                let dist = distance(index, query, neighbor, store);
                if dist < current_dist {
                    current = neighbor;
                    current_dist = dist;
                    changed = true;
                }
            }
        }

        if !changed {
            break;
        }
    }

    current
}

/// Beam search at layer 0 with deletion filtering
fn search_layer_0(
    index: &HnswIndex,
    query: &[f32],
    entry: usize,
    ef: usize,
    store: &MmapVectorStore,
    deleted: &RoaringBitmap,
) -> Vec<Candidate> {
    let entry_dist = distance(index, query, entry, store);

    let mut visited = HashSet::new();
    visited.insert(entry);

    let mut candidates: BinaryHeap<MinCandidate> = BinaryHeap::new();
    candidates.push(MinCandidate(Candidate::new(entry, entry_dist)));

    let mut results: BinaryHeap<Candidate> = BinaryHeap::new();
    if !deleted.contains(entry as u32) {
        results.push(Candidate::new(entry, entry_dist));
    }

    while let Some(MinCandidate(current)) = candidates.pop() {
        let furthest_dist = results.peek().map(|c| c.distance).unwrap_or(f32::INFINITY);

        if current.distance > furthest_dist && results.len() >= ef {
            break;
        }

        if let Some(neighbors) = index.neighbors(current.id, 0) {
            for &neighbor in neighbors {
                if visited.insert(neighbor) {
                    let dist = distance(index, query, neighbor, store);
                    let furthest = results.peek().map(|c| c.distance).unwrap_or(f32::INFINITY);

                    if dist < furthest || results.len() < ef {
                        candidates.push(MinCandidate(Candidate::new(neighbor, dist)));

                        // Only add to results if not deleted
                        if !deleted.contains(neighbor as u32) {
                            results.push(Candidate::new(neighbor, dist));
                            if results.len() > ef {
                                results.pop();
                            }
                        }
                    }
                }
            }
        }
    }

    let mut result_vec: Vec<_> = results.into_vec();
    result_vec.sort_by(|a, b| a.distance.partial_cmp(&b.distance).unwrap());
    result_vec
}

/// Beam search at layer 0 with ID filter
fn search_layer_0_filtered(
    index: &HnswIndex,
    query: &[f32],
    entry: usize,
    ef: usize,
    store: &MmapVectorStore,
    allowed: &HashSet<usize>,
) -> Vec<Candidate> {
    let entry_dist = distance(index, query, entry, store);

    let mut visited = HashSet::new();
    visited.insert(entry);

    let mut candidates: BinaryHeap<MinCandidate> = BinaryHeap::new();
    candidates.push(MinCandidate(Candidate::new(entry, entry_dist)));

    let mut results: BinaryHeap<Candidate> = BinaryHeap::new();
    if allowed.contains(&entry) {
        results.push(Candidate::new(entry, entry_dist));
    }

    // Need to explore more when filtering
    let expanded_ef = ef * 4;
    let mut explored = 0;

    while let Some(MinCandidate(current)) = candidates.pop() {
        explored += 1;
        if explored > expanded_ef * 2 {
            break;
        }

        let furthest_dist = results.peek().map(|c| c.distance).unwrap_or(f32::INFINITY);

        if current.distance > furthest_dist && results.len() >= ef {
            break;
        }

        if let Some(neighbors) = index.neighbors(current.id, 0) {
            for &neighbor in neighbors {
                if visited.insert(neighbor) {
                    let dist = distance(index, query, neighbor, store);
                    let furthest = results.peek().map(|c| c.distance).unwrap_or(f32::INFINITY);

                    // Always explore, even if not allowed
                    candidates.push(MinCandidate(Candidate::new(neighbor, dist)));

                    // Only add to results if allowed
                    if allowed.contains(&neighbor) && (dist < furthest || results.len() < ef) {
                        results.push(Candidate::new(neighbor, dist));
                        if results.len() > ef {
                            results.pop();
                        }
                    }
                }
            }
        }
    }

    let mut result_vec: Vec<_> = results.into_vec();
    result_vec.sort_by(|a, b| a.distance.partial_cmp(&b.distance).unwrap());
    result_vec
}

/// Compute distance (1 - similarity) between query and stored vector
#[inline]
fn distance(index: &HnswIndex, query: &[f32], id: usize, store: &MmapVectorStore) -> f32 {
    1.0 - index.similarity(query, id, store)
}

/// Search with trace - returns both results and the path taken through the graph
/// Trace format: (node_id, level, distance)
pub fn search_with_trace(
    index: &HnswIndex,
    query: &[f32],
    k: usize,
    ef: usize,
    store: &MmapVectorStore,
    deleted: &RoaringBitmap,
) -> (Vec<Match>, Vec<(usize, usize, f32)>) {
    let mut trace = Vec::new();

    if index.is_empty() {
        return (Vec::new(), trace);
    }

    let entry_point = match index.entry_point() {
        Some(ep) => ep,
        None => return (Vec::new(), trace),
    };

    let ef = ef.max(k);

    // Phase 1: Greedy descent through upper layers (with tracing)
    let mut current = entry_point;
    let max_level = index.max_level();

    for lc in (1..=max_level).rev() {
        current = greedy_search_layer_with_trace(index, query, current, lc, store, &mut trace);
    }

    // Phase 2: Beam search at layer 0 (with tracing)
    let candidates =
        search_layer_0_with_trace(index, query, current, ef, store, deleted, &mut trace);

    // Return top k results
    let results = candidates
        .into_iter()
        .take(k)
        .map(|c| Match {
            id: c.id,
            score: 1.0 - c.distance,
        })
        .collect();

    (results, trace)
}

/// Greedy search to find closest node at a layer (with tracing)
fn greedy_search_layer_with_trace(
    index: &HnswIndex,
    query: &[f32],
    entry: usize,
    level: usize,
    store: &MmapVectorStore,
    trace: &mut Vec<(usize, usize, f32)>,
) -> usize {
    let mut current = entry;
    let mut current_dist = distance(index, query, current, store);

    // Record entry point visit
    trace.push((current, level, current_dist));

    loop {
        let mut changed = false;

        if let Some(neighbors) = index.neighbors(current, level) {
            for &neighbor in neighbors {
                let dist = distance(index, query, neighbor, store);
                trace.push((neighbor, level, dist));

                if dist < current_dist {
                    current = neighbor;
                    current_dist = dist;
                    changed = true;
                }
            }
        }

        if !changed {
            break;
        }
    }

    current
}

/// Beam search at layer 0 with deletion filtering (with tracing)
fn search_layer_0_with_trace(
    index: &HnswIndex,
    query: &[f32],
    entry: usize,
    ef: usize,
    store: &MmapVectorStore,
    deleted: &RoaringBitmap,
    trace: &mut Vec<(usize, usize, f32)>,
) -> Vec<Candidate> {
    let entry_dist = distance(index, query, entry, store);
    trace.push((entry, 0, entry_dist));

    let mut visited = HashSet::new();
    visited.insert(entry);

    let mut candidates: BinaryHeap<MinCandidate> = BinaryHeap::new();
    candidates.push(MinCandidate(Candidate::new(entry, entry_dist)));

    let mut results: BinaryHeap<Candidate> = BinaryHeap::new();
    if !deleted.contains(entry as u32) {
        results.push(Candidate::new(entry, entry_dist));
    }

    while let Some(MinCandidate(current)) = candidates.pop() {
        let furthest_dist = results.peek().map(|c| c.distance).unwrap_or(f32::INFINITY);

        if current.distance > furthest_dist && results.len() >= ef {
            break;
        }

        if let Some(neighbors) = index.neighbors(current.id, 0) {
            for &neighbor in neighbors {
                if visited.insert(neighbor) {
                    let dist = distance(index, query, neighbor, store);
                    trace.push((neighbor, 0, dist));

                    let furthest = results.peek().map(|c| c.distance).unwrap_or(f32::INFINITY);

                    if dist < furthest || results.len() < ef {
                        candidates.push(MinCandidate(Candidate::new(neighbor, dist)));

                        if !deleted.contains(neighbor as u32) {
                            results.push(Candidate::new(neighbor, dist));
                            if results.len() > ef {
                                results.pop();
                            }
                        }
                    }
                }
            }
        }
    }

    let mut result_vec: Vec<_> = results.into_vec();
    result_vec.sort_by(|a, b| a.distance.partial_cmp(&b.distance).unwrap());
    result_vec
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn create_test_store(
        dims: usize,
        vectors: &[Vec<f32>],
    ) -> (tempfile::TempDir, MmapVectorStore) {
        let dir = tempdir().unwrap();
        let mut store = MmapVectorStore::open(dir.path(), dims).unwrap();
        for v in vectors {
            store.append(v).unwrap();
        }
        (dir, store)
    }

    #[test]
    fn test_search_empty() {
        let index = HnswIndex::new(Default::default());
        let query = vec![1.0, 0.0, 0.0, 0.0];
        let dir = tempdir().unwrap();
        let store = MmapVectorStore::open(dir.path(), 4).unwrap();
        let deleted = RoaringBitmap::new();

        let results = search(&index, &query, 5, 50, &store, &deleted);
        assert!(results.is_empty());
    }

    #[test]
    fn test_search_single() {
        let (_dir, store) = create_test_store(4, &[vec![1.0, 0.0, 0.0, 0.0]]);
        let mut index = HnswIndex::new(Default::default());

        index.insert(0, &[1.0, 0.0, 0.0, 0.0], &store);

        let deleted = RoaringBitmap::new();
        let results = search(&index, &[1.0, 0.0, 0.0, 0.0], 1, 50, &store, &deleted);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, 0);
        assert!((results[0].score - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_search_multiple() {
        let vectors = vec![
            vec![1.0, 0.0, 0.0, 0.0],
            vec![0.9, 0.1, 0.0, 0.0],
            vec![0.0, 1.0, 0.0, 0.0],
            vec![0.0, 0.0, 1.0, 0.0],
        ];
        let (_dir, store) = create_test_store(4, &vectors);
        let mut index = HnswIndex::new(Default::default());

        for (i, v) in vectors.iter().enumerate() {
            index.insert(i, v, &store);
        }

        let deleted = RoaringBitmap::new();
        let query = vec![1.0, 0.0, 0.0, 0.0];
        let results = search(&index, &query, 4, 50, &store, &deleted);

        // Verify we found results
        assert!(!results.is_empty(), "Should find results");

        // First result should be exact match (id 0)
        assert_eq!(results[0].id, 0, "First result should be exact match");
        assert!(
            (results[0].score - 1.0).abs() < 0.01,
            "Exact match should have score ~1.0"
        );

        // Second should be similar (id 1)
        assert!(
            results[1].score > 0.9,
            "Second result should have high similarity"
        );

        // Results should be sorted by score
        for i in 1..results.len() {
            assert!(
                results[i - 1].score >= results[i].score,
                "Results should be sorted by score descending"
            );
        }
    }

    #[test]
    fn test_search_with_deleted() {
        let vectors = vec![vec![1.0, 0.0, 0.0, 0.0], vec![0.9, 0.1, 0.0, 0.0]];
        let (_dir, store) = create_test_store(4, &vectors);
        let mut index = HnswIndex::new(Default::default());

        for (i, v) in vectors.iter().enumerate() {
            index.insert(i, v, &store);
        }

        let mut deleted = RoaringBitmap::new();
        deleted.insert(0); // Delete the best match

        let query = vec![1.0, 0.0, 0.0, 0.0];
        let results = search(&index, &query, 2, 50, &store, &deleted);

        // Should only return the non-deleted one
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, 1);
    }
}
