//! ID map persistence
//!
//! Saves and loads the mapping between external string IDs and internal indices.

use super::{IdMapHeader, IDMAP_MAGIC, IDMAP_VERSION};
use crate::{EmbedDbError, Result};
use roaring::RoaringBitmap;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

const HEADER_SIZE: usize = 32;

/// ID map data that can be persisted
pub struct IdMapData {
    /// External ID → Internal ID
    pub id_map: HashMap<String, usize>,
    /// Internal ID → External ID
    pub reverse_map: HashMap<usize, String>,
    /// Set of deleted internal IDs
    pub deleted: RoaringBitmap,
}

impl IdMapData {
    /// Create empty ID map data
    pub fn new() -> Self {
        Self {
            id_map: HashMap::new(),
            reverse_map: HashMap::new(),
            deleted: RoaringBitmap::new(),
        }
    }

    /// Save the ID map to disk
    ///
    /// File format:
    /// - Header (32 bytes): magic, version, count, reserved
    /// - For each entry:
    ///   - internal_id: u32
    ///   - deleted: u8 (0 or 1)
    ///   - id_len: u16
    ///   - external_id: [u8; id_len]
    pub fn save(&self, path: &Path) -> Result<()> {
        let idmap_path = path.join("idmap.db");
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&idmap_path)?;
        let mut writer = BufWriter::new(file);

        // We need to save all entries including deleted ones
        // Collect all internal IDs (both active and deleted)
        let mut all_ids: Vec<usize> = self.reverse_map.keys().copied().collect();

        // Also include deleted IDs that might not be in reverse_map
        for id in self.deleted.iter() {
            let id = id as usize;
            if !all_ids.contains(&id) {
                all_ids.push(id);
            }
        }
        all_ids.sort_unstable();

        // Build header
        let header = IdMapHeader {
            magic: IDMAP_MAGIC,
            version: IDMAP_VERSION,
            count: all_ids.len() as u32,
            _reserved1: 0,
            _reserved2: [0; 16],
        };

        // Write header
        writer.write_all(bytemuck::bytes_of(&header))?;

        // Write each entry
        for internal_id in &all_ids {
            let internal_id_u32 = *internal_id as u32;
            let is_deleted = self.deleted.contains(*internal_id as u32);

            // Get external ID (might be empty for deleted entries not in reverse_map)
            let external_id = self
                .reverse_map
                .get(internal_id)
                .cloned()
                .unwrap_or_default();

            writer.write_all(&internal_id_u32.to_le_bytes())?;
            writer.write_all(&[is_deleted as u8])?;

            let id_len = external_id.len() as u16;
            writer.write_all(&id_len.to_le_bytes())?;
            writer.write_all(external_id.as_bytes())?;
        }

        writer.flush()?;
        writer.get_ref().sync_all()?;
        Ok(())
    }

    /// Load the ID map from disk
    pub fn load(path: &Path) -> Result<Self> {
        let idmap_path = path.join("idmap.db");

        if !idmap_path.exists() {
            return Ok(Self::new());
        }

        let file = File::open(&idmap_path)?;
        let file_len = file.metadata()?.len() as usize;
        let mut reader = BufReader::new(file);

        if file_len < HEADER_SIZE {
            return Err(EmbedDbError::Corrupted("ID map file too small".into()));
        }

        // Read header
        let mut header_bytes = [0u8; HEADER_SIZE];
        reader.read_exact(&mut header_bytes)?;
        let header: IdMapHeader = *bytemuck::from_bytes(&header_bytes);

        // Validate header
        if header.magic != IDMAP_MAGIC {
            return Err(EmbedDbError::Corrupted(format!(
                "Invalid ID map magic: 0x{:08X}",
                header.magic
            )));
        }
        if header.version > IDMAP_VERSION {
            return Err(EmbedDbError::Corrupted(format!(
                "Unsupported ID map version: {}",
                header.version
            )));
        }

        let count = header.count as usize;
        let mut id_map = HashMap::with_capacity(count);
        let mut reverse_map = HashMap::with_capacity(count);
        let mut deleted = RoaringBitmap::new();

        // Read entries
        for _ in 0..count {
            // Read internal ID
            let mut id_bytes = [0u8; 4];
            reader.read_exact(&mut id_bytes)?;
            let internal_id = u32::from_le_bytes(id_bytes) as usize;

            // Read deleted flag
            let mut deleted_byte = [0u8; 1];
            reader.read_exact(&mut deleted_byte)?;
            let is_deleted = deleted_byte[0] != 0;

            // Read external ID length
            let mut len_bytes = [0u8; 2];
            reader.read_exact(&mut len_bytes)?;
            let id_len = u16::from_le_bytes(len_bytes) as usize;

            // Read external ID
            let mut id_bytes = vec![0u8; id_len];
            reader.read_exact(&mut id_bytes)?;
            let external_id = String::from_utf8(id_bytes)
                .map_err(|e| EmbedDbError::Corrupted(format!("Invalid UTF-8 in ID: {}", e)))?;

            if is_deleted {
                deleted.insert(internal_id as u32);
            }

            if !external_id.is_empty() {
                id_map.insert(external_id.clone(), internal_id);
                reverse_map.insert(internal_id, external_id);
            }
        }

        Ok(Self {
            id_map,
            reverse_map,
            deleted,
        })
    }
}

impl Default for IdMapData {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_save_load_empty() {
        let dir = tempdir().unwrap();
        let data = IdMapData::new();

        data.save(dir.path()).unwrap();
        let loaded = IdMapData::load(dir.path()).unwrap();

        assert!(loaded.id_map.is_empty());
        assert!(loaded.reverse_map.is_empty());
        assert!(loaded.deleted.is_empty());
    }

    #[test]
    fn test_save_load_with_data() {
        let dir = tempdir().unwrap();
        let mut data = IdMapData::new();

        data.id_map.insert("doc1".to_string(), 0);
        data.id_map.insert("doc2".to_string(), 1);
        data.id_map.insert("doc3".to_string(), 2);

        data.reverse_map.insert(0, "doc1".to_string());
        data.reverse_map.insert(1, "doc2".to_string());
        data.reverse_map.insert(2, "doc3".to_string());

        data.save(dir.path()).unwrap();
        let loaded = IdMapData::load(dir.path()).unwrap();

        assert_eq!(loaded.id_map.len(), 3);
        assert_eq!(loaded.id_map.get("doc1"), Some(&0));
        assert_eq!(loaded.id_map.get("doc2"), Some(&1));
        assert_eq!(loaded.id_map.get("doc3"), Some(&2));

        assert_eq!(loaded.reverse_map.get(&0), Some(&"doc1".to_string()));
        assert_eq!(loaded.reverse_map.get(&1), Some(&"doc2".to_string()));
        assert_eq!(loaded.reverse_map.get(&2), Some(&"doc3".to_string()));
    }

    #[test]
    fn test_save_load_with_deleted() {
        let dir = tempdir().unwrap();
        let mut data = IdMapData::new();

        data.id_map.insert("doc1".to_string(), 0);
        data.id_map.insert("doc3".to_string(), 2);

        data.reverse_map.insert(0, "doc1".to_string());
        data.reverse_map.insert(2, "doc3".to_string());

        // Mark doc2 (internal ID 1) as deleted
        data.deleted.insert(1);

        data.save(dir.path()).unwrap();
        let loaded = IdMapData::load(dir.path()).unwrap();

        assert_eq!(loaded.id_map.len(), 2);
        assert!(!loaded.id_map.contains_key("doc2"));
        assert!(loaded.deleted.contains(1));
    }

    #[test]
    fn test_load_nonexistent() {
        let dir = tempdir().unwrap();
        let loaded = IdMapData::load(dir.path()).unwrap();

        assert!(loaded.id_map.is_empty());
        assert!(loaded.reverse_map.is_empty());
        assert!(loaded.deleted.is_empty());
    }

    #[test]
    fn test_unicode_ids() {
        let dir = tempdir().unwrap();
        let mut data = IdMapData::new();

        data.id_map.insert("文档1".to_string(), 0);
        data.id_map.insert("文档2".to_string(), 1);

        data.reverse_map.insert(0, "文档1".to_string());
        data.reverse_map.insert(1, "文档2".to_string());

        data.save(dir.path()).unwrap();
        let loaded = IdMapData::load(dir.path()).unwrap();

        assert_eq!(loaded.id_map.get("文档1"), Some(&0));
        assert_eq!(loaded.id_map.get("文档2"), Some(&1));
    }
}
