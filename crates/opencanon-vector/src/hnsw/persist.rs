//! HNSW index persistence
//!
//! Saves and loads the HNSW graph structure to/from disk.

use super::index::{HnswConfig, HnswIndex};
use crate::store::{HnswHeader, HNSW_MAGIC, HNSW_VERSION};
use crate::{EmbedDbError, Result};
use bytemuck::{Pod, Zeroable};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

const HEADER_SIZE: usize = 64;

/// Node metadata stored in the file
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
struct NodeMeta {
    /// Node's level in the graph
    level: u8,
    /// Padding for alignment
    _pad: [u8; 3],
    /// Offset into neighbor data section
    neighbors_offset: u32,
}

impl HnswIndex {
    /// Save the index to a file
    pub fn save(&self, path: &Path) -> Result<()> {
        let hnsw_path = path.join("hnsw.db");
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&hnsw_path)?;

        // Build header
        let config = self.config();
        let header = HnswHeader {
            magic: HNSW_MAGIC,
            version: HNSW_VERSION,
            count: self.len() as u32,
            entry_point: self.entry_point().unwrap_or(u32::MAX as usize) as u32,
            max_level: self.max_level() as u32,
            m: config.m as u32,
            m_max0: config.m_max0 as u32,
            ef_construction: config.ef_construction as u32,
            _reserved: [0; 32],
        };

        // Write header
        file.write_all(bytemuck::bytes_of(&header))?;

        // Calculate neighbor data and build node metadata
        let mut neighbor_data: Vec<u8> = Vec::new();
        let levels = self.levels();
        let all_neighbors = self.all_neighbors();
        let mut node_metas: Vec<NodeMeta> = Vec::with_capacity(levels.len());

        for (node_id, node_neighbors) in all_neighbors.iter().enumerate() {
            let level = levels.get(node_id).copied().unwrap_or(0);
            let offset = neighbor_data.len() as u32;

            node_metas.push(NodeMeta {
                level: level as u8,
                _pad: [0; 3],
                neighbors_offset: offset,
            });

            // Write neighbor data for this node
            // Format: for each level: count (u16) + neighbors (u32 each)
            for level_neighbors in node_neighbors.iter() {
                let count = level_neighbors.len() as u16;
                neighbor_data.extend_from_slice(&count.to_le_bytes());
                for &neighbor in level_neighbors {
                    neighbor_data.extend_from_slice(&(neighbor as u32).to_le_bytes());
                }
            }
        }

        // Write node metadata
        for meta in &node_metas {
            file.write_all(bytemuck::bytes_of(meta))?;
        }

        // Write neighbor data
        file.write_all(&neighbor_data)?;

        file.sync_all()?;
        Ok(())
    }

    /// Load the index from a file
    pub fn load(path: &Path) -> Result<Self> {
        let hnsw_path = path.join("hnsw.db");

        if !hnsw_path.exists() {
            // No saved index, return empty
            return Ok(Self::new(HnswConfig::default()));
        }

        let mut file = File::open(&hnsw_path)?;
        let file_len = file.metadata()?.len() as usize;

        if file_len < HEADER_SIZE {
            return Err(EmbedDbError::Corrupted("HNSW file too small".into()));
        }

        // Read header
        let mut header_bytes = [0u8; HEADER_SIZE];
        file.read_exact(&mut header_bytes)?;
        let header: HnswHeader = *bytemuck::from_bytes(&header_bytes);

        header
            .validate()
            .map_err(|error| EmbedDbError::Corrupted(error.to_string()))?;

        let count = header.count as usize;
        let config = HnswConfig {
            m: header.m as usize,
            m_max0: header.m_max0 as usize,
            ef_construction: header.ef_construction as usize,
            ef_search: 50, // Default, not stored in header
            ml: 1.0 / (header.m as f64).ln(),
        };

        if count == 0 {
            return Ok(Self::new(config));
        }

        // Read node metadata
        let meta_size = count * std::mem::size_of::<NodeMeta>();
        let mut meta_bytes = vec![0u8; meta_size];
        file.read_exact(&mut meta_bytes)?;

        let node_metas: Vec<NodeMeta> = meta_bytes
            .chunks_exact(std::mem::size_of::<NodeMeta>())
            .map(|chunk| *bytemuck::from_bytes(chunk))
            .collect();

        // Read neighbor data
        let neighbor_data_start = HEADER_SIZE + meta_size;
        let neighbor_data_size = file_len - neighbor_data_start;
        let mut neighbor_data = vec![0u8; neighbor_data_size];
        file.read_exact(&mut neighbor_data)?;

        // Reconstruct levels and neighbors
        let mut levels = Vec::with_capacity(count);
        let mut neighbors: Vec<Vec<Vec<usize>>> = Vec::with_capacity(count);

        for meta in &node_metas {
            let level = meta.level as usize;
            levels.push(level);

            let mut node_neighbors = Vec::with_capacity(level + 1);
            let mut offset = meta.neighbors_offset as usize;

            for _ in 0..=level {
                if offset + 2 > neighbor_data.len() {
                    return Err(EmbedDbError::Corrupted("Neighbor data truncated".into()));
                }

                let count_bytes: [u8; 2] = neighbor_data[offset..offset + 2].try_into().unwrap();
                let neighbor_count = u16::from_le_bytes(count_bytes) as usize;
                offset += 2;

                let mut level_neighbors = Vec::with_capacity(neighbor_count);
                for _ in 0..neighbor_count {
                    if offset + 4 > neighbor_data.len() {
                        return Err(EmbedDbError::Corrupted("Neighbor data truncated".into()));
                    }
                    let id_bytes: [u8; 4] = neighbor_data[offset..offset + 4].try_into().unwrap();
                    level_neighbors.push(u32::from_le_bytes(id_bytes) as usize);
                    offset += 4;
                }
                node_neighbors.push(level_neighbors);
            }
            neighbors.push(node_neighbors);
        }

        let entry_point = if header.entry_point == u32::MAX {
            None
        } else {
            Some(header.entry_point as usize)
        };

        Ok(Self::from_parts(
            config,
            levels,
            neighbors,
            entry_point,
            header.max_level as usize,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_save_load_empty() {
        let dir = tempdir().unwrap();
        let index = HnswIndex::new(HnswConfig::default());

        index.save(dir.path()).unwrap();
        let loaded = HnswIndex::load(dir.path()).unwrap();

        assert_eq!(loaded.len(), 0);
        assert!(loaded.entry_point().is_none());
    }

    #[test]
    fn test_save_load_with_data() {
        let dir = tempdir().unwrap();
        let mut index = HnswIndex::new(HnswConfig::default());

        // Manually build a small graph
        index.add_node(0);
        index.add_node(1);
        index.add_node(0);

        index.set_neighbors(0, 0, vec![1, 2]);
        index.set_neighbors(1, 0, vec![0, 2]);
        index.set_neighbors(1, 1, vec![]);
        index.set_neighbors(2, 0, vec![0, 1]);

        index.save(dir.path()).unwrap();
        let loaded = HnswIndex::load(dir.path()).unwrap();

        assert_eq!(loaded.len(), 3);
        assert_eq!(loaded.entry_point(), Some(1));
        assert_eq!(loaded.max_level(), 1);

        // Check neighbors
        assert_eq!(loaded.neighbors(0, 0), Some(&[1usize, 2][..]));
        assert_eq!(loaded.neighbors(1, 0), Some(&[0usize, 2][..]));
        assert_eq!(loaded.neighbors(2, 0), Some(&[0usize, 1][..]));
    }

    #[test]
    fn test_load_nonexistent() {
        let dir = tempdir().unwrap();
        let loaded = HnswIndex::load(dir.path()).unwrap();
        assert_eq!(loaded.len(), 0);
    }
}
