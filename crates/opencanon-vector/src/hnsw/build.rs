//! HNSW index construction algorithms

use super::index::{Candidate, HnswIndex, MinCandidate};
use crate::store::MmapVectorStore;
use std::collections::{BinaryHeap, HashSet};

/// Insert a new vector into the index
pub fn insert(index: &mut HnswIndex, id: usize, vector: &[f32], store: &MmapVectorStore) {
    // Generate random level for this node
    let level = index.random_level();

    // Add placeholder nodes if there are gaps (shouldn't happen in normal use)
    while index.len() < id {
        index.add_node(0);
    }

    // Add this node if it doesn't exist yet
    if index.len() == id {
        index.add_node(level);
    }

    // Handle first node specially
    if index.len() == 1 {
        // First node is already the entry point, nothing to connect
        return;
    }

    // Get current entry point (before potentially changing it)
    let entry_point = match index.entry_point() {
        Some(ep) if ep != id => ep,
        _ => {
            // We are the entry point or no entry point - find another node to start from
            // This happens when our level is higher than all existing nodes
            // Start from node 0 or first available
            (0..index.len()).find(|&i| i != id).unwrap_or(0)
        }
    };

    let ef_construction = index.config().ef_construction;
    let node_level = level;
    let max_level = index.max_level();
    let mut current_ep = entry_point;

    // Phase 1: Greedy descent from top layer to node's layer + 1
    // (only if we're not at the top)
    for lc in ((node_level + 1)..=max_level).rev() {
        if let Some(neighbors) = index.neighbors(current_ep, lc) {
            if !neighbors.is_empty() {
                current_ep = greedy_search_layer(index, vector, current_ep, lc, store);
            }
        }
    }

    // Phase 2: Insert at each layer from node's level down to 0
    let insert_level = node_level.min(max_level);
    for lc in (0..=insert_level).rev() {
        // Find ef_construction nearest neighbors at this layer
        let candidates = search_layer(index, vector, current_ep, ef_construction, lc, store, id);

        // Select M neighbors using diversity heuristic
        let max_conn = index.max_connections(lc);
        let neighbors = select_neighbors_heuristic(vector, &candidates, max_conn, store, id);

        // Create bidirectional connections (excluding self)
        let neighbors: Vec<usize> = neighbors.into_iter().filter(|&n| n != id).collect();
        index.set_neighbors(id, lc, neighbors.clone());

        for &neighbor_id in &neighbors {
            if neighbor_id != id {
                add_connection(index, neighbor_id, id, lc, store);
            }
        }

        // Update entry point for next layer
        if !candidates.is_empty() {
            current_ep = candidates[0].id;
        }
    }
}

/// Greedy search to find the closest node at a given layer
fn greedy_search_layer(
    index: &HnswIndex,
    query: &[f32],
    entry: usize,
    level: usize,
    store: &MmapVectorStore,
) -> usize {
    let mut current = entry;
    let mut current_dist = 1.0 - index.similarity(query, current, store);

    loop {
        let mut changed = false;

        if let Some(neighbors) = index.neighbors(current, level) {
            for &neighbor in neighbors {
                let dist = 1.0 - index.similarity(query, neighbor, store);
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

/// Beam search at a layer to find ef nearest candidates
fn search_layer(
    index: &HnswIndex,
    query: &[f32],
    entry: usize,
    ef: usize,
    level: usize,
    store: &MmapVectorStore,
    exclude_id: usize,
) -> Vec<Candidate> {
    let entry_dist = 1.0 - index.similarity(query, entry, store);

    let mut visited = HashSet::new();
    visited.insert(entry);
    visited.insert(exclude_id); // Don't include the node we're inserting

    // Min-heap for candidates to explore (closest first)
    let mut candidates: BinaryHeap<MinCandidate> = BinaryHeap::new();
    if entry != exclude_id {
        candidates.push(MinCandidate(Candidate::new(entry, entry_dist)));
    }

    // Max-heap for results (furthest first, for easy pruning)
    let mut results: BinaryHeap<Candidate> = BinaryHeap::new();
    if entry != exclude_id {
        results.push(Candidate::new(entry, entry_dist));
    }

    while let Some(MinCandidate(current)) = candidates.pop() {
        let furthest_dist = results.peek().map(|c| c.distance).unwrap_or(f32::INFINITY);

        if current.distance > furthest_dist && results.len() >= ef {
            break;
        }

        if let Some(neighbors) = index.neighbors(current.id, level) {
            for &neighbor in neighbors {
                if neighbor == exclude_id {
                    continue;
                }
                if visited.insert(neighbor) {
                    let dist = 1.0 - index.similarity(query, neighbor, store);
                    let furthest_dist = results.peek().map(|c| c.distance).unwrap_or(f32::INFINITY);

                    if dist < furthest_dist || results.len() < ef {
                        candidates.push(MinCandidate(Candidate::new(neighbor, dist)));
                        results.push(Candidate::new(neighbor, dist));

                        if results.len() > ef {
                            results.pop();
                        }
                    }
                }
            }
        }
    }

    // NOTE: Previously there was an O(n) scan of all nodes at level 0 here.
    // This has been removed as it caused O(n²) behavior for bulk inserts.
    // The HNSW algorithm ensures connectivity through the regular neighbor selection process.

    // Convert to sorted vec (closest first)
    let mut result_vec: Vec<_> = results.into_vec();
    result_vec.sort_by(|a, b| a.distance.partial_cmp(&b.distance).unwrap());
    result_vec
}

/// Select neighbors using diversity heuristic
fn select_neighbors_heuristic(
    _query: &[f32],
    candidates: &[Candidate],
    max_neighbors: usize,
    store: &MmapVectorStore,
    exclude_id: usize,
) -> Vec<usize> {
    if candidates.is_empty() {
        return Vec::new();
    }

    let mut selected = Vec::with_capacity(max_neighbors);

    for candidate in candidates {
        if candidate.id == exclude_id {
            continue;
        }
        if selected.len() >= max_neighbors {
            break;
        }

        let candidate_vec = match store.get(candidate.id) {
            Some(v) => v,
            None => continue,
        };

        // Check if candidate is closer to query than to any selected neighbor
        let mut keep = true;
        for &neighbor_id in &selected {
            if let Some(neighbor_vec) = store.get(neighbor_id) {
                let dist_to_neighbor = 1.0 - cosine_similarity_inline(candidate_vec, neighbor_vec);
                if dist_to_neighbor < candidate.distance {
                    keep = false;
                    break;
                }
            }
        }

        if keep {
            selected.push(candidate.id);
        }
    }

    selected
}

/// Add a bidirectional connection, pruning if necessary
fn add_connection(
    index: &mut HnswIndex,
    from: usize,
    to: usize,
    level: usize,
    store: &MmapVectorStore,
) {
    if from == to {
        return;
    }

    let max_conn = index.max_connections(level);

    if let Some(neighbors) = index.neighbors_mut(from, level) {
        if !neighbors.contains(&to) {
            neighbors.push(to);

            // Prune if over capacity
            if neighbors.len() > max_conn {
                prune_connections(index, from, level, max_conn, store);
            }
        }
    }
}

/// Prune connections to keep only the best ones
fn prune_connections(
    index: &mut HnswIndex,
    node: usize,
    level: usize,
    max_conn: usize,
    store: &MmapVectorStore,
) {
    let node_vec = match store.get(node) {
        Some(v) => v.to_vec(),
        None => return,
    };

    let neighbors = match index.neighbors(node, level) {
        Some(n) => n.to_vec(),
        None => return,
    };

    // Score each neighbor by similarity
    let mut scored: Vec<(usize, f32)> = neighbors
        .iter()
        .filter(|&&neighbor| neighbor != node)
        .filter_map(|&neighbor| {
            store.get(neighbor).map(|v| {
                let sim = cosine_similarity_inline(&node_vec, v);
                (neighbor, sim)
            })
        })
        .collect();

    // Sort by similarity (highest first)
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

    // Keep top max_conn
    let new_neighbors: Vec<usize> = scored
        .into_iter()
        .take(max_conn)
        .map(|(id, _)| id)
        .collect();
    index.set_neighbors(node, level, new_neighbors);
}

/// Inline cosine similarity for build operations
#[inline]
fn cosine_similarity_inline(a: &[f32], b: &[f32]) -> f32 {
    crate::simd::cosine_similarity(a, b)
}
