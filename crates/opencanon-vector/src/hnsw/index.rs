//! Core HNSW index structure

use crate::simd::cosine_similarity;
use crate::store::MmapVectorStore;
use crate::Match;
use roaring::RoaringBitmap;
use std::cmp::Ordering;

/// HNSW configuration parameters
#[derive(Debug, Clone)]
pub struct HnswConfig {
    /// Max connections per node per layer (default: 16)
    pub m: usize,
    /// Max connections at layer 0 (default: 2 * m = 32)
    pub m_max0: usize,
    /// Build quality / candidate pool size (default: 200)
    pub ef_construction: usize,
    /// Search quality / beam width (default: 50)
    pub ef_search: usize,
    /// Level multiplier = 1 / ln(m)
    pub ml: f64,
}

impl Default for HnswConfig {
    fn default() -> Self {
        let m = 16;
        Self {
            m,
            m_max0: m * 2,
            ef_construction: 200,
            ef_search: 50,
            ml: 1.0 / (m as f64).ln(),
        }
    }
}

impl HnswConfig {
    pub fn new(m: usize, ef_construction: usize, ef_search: usize) -> Self {
        Self {
            m,
            m_max0: m * 2,
            ef_construction,
            ef_search,
            ml: 1.0 / (m as f64).ln(),
        }
    }
}

/// Candidate node for search/build operations
#[derive(Clone, Copy)]
pub(crate) struct Candidate {
    pub id: usize,
    pub distance: f32,
}

impl Candidate {
    pub fn new(id: usize, distance: f32) -> Self {
        Self { id, distance }
    }
}

// For max-heap (furthest first)
impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> Ordering {
        self.distance
            .partial_cmp(&other.distance)
            .unwrap_or(Ordering::Equal)
    }
}

impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Eq for Candidate {}

impl PartialEq for Candidate {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

/// Wrapper for min-heap ordering (closest first)
#[derive(Clone, Copy)]
pub(crate) struct MinCandidate(pub Candidate);

impl Ord for MinCandidate {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .0
            .distance
            .partial_cmp(&self.0.distance)
            .unwrap_or(Ordering::Equal)
    }
}

impl PartialOrd for MinCandidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Eq for MinCandidate {}

impl PartialEq for MinCandidate {
    fn eq(&self, other: &Self) -> bool {
        self.0.id == other.0.id
    }
}

/// HNSW index
pub struct HnswIndex {
    config: HnswConfig,
    /// Level assigned to each node
    levels: Vec<usize>,
    /// Neighbor lists: neighbors[node][level] = [neighbor_ids]
    neighbors: Vec<Vec<Vec<usize>>>,
    /// Entry point (node with highest level)
    entry_point: Option<usize>,
    /// Maximum level in the graph
    max_level: usize,
}

impl HnswIndex {
    /// Create a new empty HNSW index
    pub fn new(config: HnswConfig) -> Self {
        Self {
            config,
            levels: Vec::new(),
            neighbors: Vec::new(),
            entry_point: None,
            max_level: 0,
        }
    }

    /// Create an index from loaded parts (used by persistence)
    pub(crate) fn from_parts(
        config: HnswConfig,
        levels: Vec<usize>,
        neighbors: Vec<Vec<Vec<usize>>>,
        entry_point: Option<usize>,
        max_level: usize,
    ) -> Self {
        Self {
            config,
            levels,
            neighbors,
            entry_point,
            max_level,
        }
    }

    /// Get levels (for persistence)
    pub(crate) fn levels(&self) -> &[usize] {
        &self.levels
    }

    /// Get all neighbors (for persistence)
    pub(crate) fn all_neighbors(&self) -> &[Vec<Vec<usize>>] {
        &self.neighbors
    }

    /// Create with legacy parameters (for backwards compatibility)
    pub fn with_params(m: usize, ef_construction: usize) -> Self {
        Self::new(HnswConfig::new(m, ef_construction, 50))
    }

    /// Get the configuration
    pub fn config(&self) -> &HnswConfig {
        &self.config
    }

    /// Get number of nodes in the index
    pub fn len(&self) -> usize {
        self.levels.len()
    }

    /// Check if index is empty
    pub fn is_empty(&self) -> bool {
        self.levels.is_empty()
    }

    /// Get entry point
    pub fn entry_point(&self) -> Option<usize> {
        self.entry_point
    }

    /// Get max level
    pub fn max_level(&self) -> usize {
        self.max_level
    }

    /// Get the level of a node
    pub fn node_level(&self, id: usize) -> Option<usize> {
        self.levels.get(id).copied()
    }

    /// Get neighbors of a node at a specific level
    pub fn neighbors(&self, id: usize, level: usize) -> Option<&[usize]> {
        self.neighbors.get(id)?.get(level).map(|v| v.as_slice())
    }

    /// Get mutable neighbors reference (for building)
    pub(crate) fn neighbors_mut(&mut self, id: usize, level: usize) -> Option<&mut Vec<usize>> {
        self.neighbors.get_mut(id)?.get_mut(level)
    }

    /// Get the number of nodes in the index
    pub fn node_count(&self) -> usize {
        self.neighbors.len()
    }

    /// Remove edges pointing to deleted nodes from the graph
    ///
    /// Returns the number of edges removed.
    pub fn cleanup_deleted_edges(&mut self, deleted: &RoaringBitmap) -> usize {
        let mut edges_removed = 0;

        for node_id in 0..self.neighbors.len() {
            // Skip if this node is deleted (its edges don't matter)
            if deleted.contains(node_id as u32) {
                continue;
            }

            if let Some(node_neighbors) = self.neighbors.get_mut(node_id) {
                for level_neighbors in node_neighbors.iter_mut() {
                    let original_len = level_neighbors.len();
                    level_neighbors.retain(|&neighbor_id| !deleted.contains(neighbor_id as u32));
                    edges_removed += original_len - level_neighbors.len();
                }
            }
        }

        edges_removed
    }

    /// Generate random level for a new node using exponential distribution
    pub(crate) fn random_level(&self) -> usize {
        let mut level = 0;
        let ml = self.config.ml;
        while rand::random::<f64>() < ml && level < 32 {
            level += 1;
        }
        level
    }

    /// Add a new node with the given level
    pub(crate) fn add_node(&mut self, level: usize) -> usize {
        let id = self.levels.len();
        self.levels.push(level);

        // Create empty neighbor lists for each level
        let mut node_neighbors = Vec::with_capacity(level + 1);
        for _ in 0..=level {
            node_neighbors.push(Vec::new());
        }
        self.neighbors.push(node_neighbors);

        // Update entry point if this node has higher level
        if self.entry_point.is_none() || level > self.max_level {
            self.entry_point = Some(id);
            self.max_level = level;
        }

        id
    }

    /// Set neighbors for a node at a level
    pub(crate) fn set_neighbors(&mut self, id: usize, level: usize, neighbors: Vec<usize>) {
        if let Some(node_neighbors) = self.neighbors.get_mut(id) {
            if let Some(level_neighbors) = node_neighbors.get_mut(level) {
                *level_neighbors = neighbors;
            }
        }
    }

    /// Get max connections allowed at a level
    pub(crate) fn max_connections(&self, level: usize) -> usize {
        if level == 0 {
            self.config.m_max0
        } else {
            self.config.m
        }
    }

    /// Compute similarity between query and a stored vector
    pub(crate) fn similarity(&self, query: &[f32], id: usize, store: &MmapVectorStore) -> f32 {
        if let Some(vector) = store.get(id) {
            cosine_similarity(query, vector)
        } else {
            f32::NEG_INFINITY
        }
    }

    /// Insert a new vector into the index
    pub fn insert(&mut self, id: usize, vector: &[f32], store: &MmapVectorStore) {
        super::build::insert(self, id, vector, store);
    }

    /// Search for k nearest neighbors
    pub fn search(
        &self,
        query: &[f32],
        k: usize,
        ef: usize,
        store: &MmapVectorStore,
        deleted: &RoaringBitmap,
    ) -> Vec<Match> {
        super::search::search(self, query, k, ef, store, deleted)
    }

    /// Search with a filter on allowed IDs
    pub fn search_filtered(
        &self,
        query: &[f32],
        k: usize,
        ef: usize,
        store: &MmapVectorStore,
        allowed_ids: &[usize],
    ) -> Vec<Match> {
        super::search::search_filtered(self, query, k, ef, store, allowed_ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_defaults() {
        let config = HnswConfig::default();
        assert_eq!(config.m, 16);
        assert_eq!(config.m_max0, 32);
        assert_eq!(config.ef_construction, 200);
        assert_eq!(config.ef_search, 50);
    }

    #[test]
    fn test_random_level_distribution() {
        let index = HnswIndex::new(HnswConfig::default());

        // Generate many levels and check distribution
        let mut level_counts = [0usize; 10];
        for _ in 0..10000 {
            let level = index.random_level();
            if level < level_counts.len() {
                level_counts[level] += 1;
            }
        }

        // Level 0 should be most common
        assert!(
            level_counts[0] > level_counts[1],
            "Level 0 should be more common than level 1: {} vs {}",
            level_counts[0],
            level_counts[1]
        );

        // Majority should be at level 0
        assert!(
            level_counts[0] > 5000,
            "Majority should be at level 0, got {}",
            level_counts[0]
        );
    }
}
