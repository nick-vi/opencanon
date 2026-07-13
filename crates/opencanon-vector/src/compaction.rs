use crate::{
    CompactionResult, Config, EmbedDbError, EmbeddingDb, HnswConfig, HnswIndex, IdMapData,
    MmapVectorStore, Result,
};
use parking_lot::RwLock;
use roaring::RoaringBitmap;
use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

/// Internal state shared between CompactionHandle and the background thread
struct CompactionState {
    /// Whether compaction is complete
    complete: AtomicBool,
    /// Progress from 0 to 100 (percentage * 100)
    progress: AtomicU64,
    /// Total vectors to process
    total: AtomicU64,
    /// Vectors processed so far
    processed: AtomicU64,
    /// Result of the compaction (set when complete)
    result: RwLock<Option<Result<CompactionResult>>>,
}

impl CompactionState {
    fn new(total: u64) -> Self {
        Self {
            complete: AtomicBool::new(false),
            progress: AtomicU64::new(0),
            total: AtomicU64::new(total),
            processed: AtomicU64::new(0),
            result: RwLock::new(None),
        }
    }

    fn update_progress(&self, processed: u64) {
        self.processed.store(processed, Ordering::Relaxed);
        let total = self.total.load(Ordering::Relaxed);
        if let Some(progress) = (processed * 100).checked_div(total) {
            self.progress.store(progress, Ordering::Relaxed);
        }
    }

    fn set_complete(&self, result: Result<CompactionResult>) {
        *self.result.write() = Some(result);
        self.progress.store(100, Ordering::Release);
        self.complete.store(true, Ordering::Release);
    }
}

/// Handle for tracking async compaction progress
pub struct CompactionHandle {
    state: Arc<CompactionState>,
    thread_handle: Option<std::thread::JoinHandle<()>>,
}

impl CompactionHandle {
    /// Check if compaction is complete
    pub fn is_complete(&self) -> bool {
        self.state.complete.load(Ordering::Acquire)
    }

    /// Get progress (0.0 to 1.0)
    pub fn progress(&self) -> f64 {
        self.state.progress.load(Ordering::Relaxed) as f64 / 100.0
    }

    /// Wait for compaction to complete and return the result
    pub fn wait(mut self) -> Result<CompactionResult> {
        // Wait for the thread to finish
        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }

        // Get the result
        let result = self.state.result.write().take();
        result.unwrap_or(Err(EmbedDbError::Corrupted(
            "Compaction thread completed without result".to_string(),
        )))
    }
}

impl EmbeddingDb {
    /// Compact the database, reclaiming disk space from deleted vectors
    ///
    /// This performs a full rebuild:
    /// 1. Creates new files in a temporary directory
    /// 2. Copies all non-deleted vectors with new contiguous indices
    /// 3. Rebuilds the HNSW index from scratch
    /// 4. Atomically swaps old files for new ones
    /// 5. Cleans up old files
    ///
    /// Returns a `CompactionResult` with statistics about the operation.
    ///
    /// # Safety
    ///
    /// This operation is crash-safe. If interrupted:
    /// - Old data remains intact
    /// - Incomplete compaction is detected and cleaned up on next open
    ///
    /// # Example
    /// ```ignore
    /// if db.should_compact() {
    ///     let result = db.compact()?;
    ///     println!("Compacted: removed {} vectors, kept {}",
    ///         result.vectors_removed, result.vectors_kept);
    /// }
    /// ```
    pub fn compact(&mut self) -> Result<CompactionResult> {
        // Force checkpoint before compaction to ensure all WAL records are persisted
        self.flush()?;

        let deleted = self.deleted.read();
        let deleted_count = deleted.len() as usize;
        let total_count = self.store.len();
        let active_count = total_count - deleted_count;

        // Nothing to compact
        if deleted_count == 0 {
            return Ok(CompactionResult {
                vectors_removed: 0,
                vectors_kept: active_count,
                bytes_reclaimed: 0,
                duration_ms: 0,
            });
        }

        drop(deleted);

        // Check disk space before starting
        self.check_disk_space_for_compaction()?;

        let start = std::time::Instant::now();

        // Calculate space that will be reclaimed
        let bytes_per_vector = self.config.dimensions * 4;
        let bytes_reclaimed = deleted_count * bytes_per_vector;

        // Create temp directory for new files
        let temp_path = self.path.join(".compact_temp");
        if temp_path.exists() {
            std::fs::remove_dir_all(&temp_path)?;
        }
        std::fs::create_dir_all(&temp_path)?;

        // Create new vector store
        let mut new_store = MmapVectorStore::open(&temp_path, self.config.dimensions)?;

        // Create new HNSW index
        let hnsw_config = HnswConfig::new(
            self.config.m,
            self.config.ef_construction,
            self.config.ef_search,
        );
        let mut new_index = HnswIndex::new(hnsw_config);

        // Build mappings: old internal ID → new internal ID
        let mut new_id_map: HashMap<String, usize> = HashMap::with_capacity(active_count);
        let mut new_reverse_map: HashMap<usize, String> = HashMap::with_capacity(active_count);

        // Copy non-deleted vectors
        {
            let deleted = self.deleted.read();
            let reverse_map = self.reverse_id_map.read();

            for old_internal_id in 0..total_count {
                // Skip deleted vectors
                if deleted.contains(old_internal_id as u32) {
                    continue;
                }

                // Get the vector
                let vector = match self.store.get(old_internal_id) {
                    Some(v) => v,
                    None => continue,
                };

                // Get the external ID
                let external_id = match reverse_map.get(&old_internal_id) {
                    Some(id) => id.clone(),
                    None => continue,
                };

                // Append to new store (gets new internal ID)
                let new_internal_id = new_store.append(vector)?;

                // Update mappings
                new_id_map.insert(external_id.clone(), new_internal_id);
                new_reverse_map.insert(new_internal_id, external_id);

                // Insert into new HNSW index
                new_index.insert(new_internal_id, vector, &new_store);
            }
        }

        // Save new index and id map to temp directory
        new_store.flush()?;
        new_index.save(&temp_path)?;

        let new_id_map_data = IdMapData {
            id_map: new_id_map.clone(),
            reverse_map: new_reverse_map.clone(),
            deleted: RoaringBitmap::new(),
        };
        new_id_map_data.save(&temp_path)?;

        // Atomic swap: rename old files to backup, then temp to main
        let backup_path = self.path.join(".compact_backup");
        if backup_path.exists() {
            std::fs::remove_dir_all(&backup_path)?;
        }

        // Move current files to backup
        self.move_db_files(&self.path, &backup_path)?;

        // Move new files to main path
        self.move_db_files(&temp_path, &self.path)?;

        // Clean up temp and backup directories
        if temp_path.exists() {
            std::fs::remove_dir_all(&temp_path)?;
        }
        if backup_path.exists() {
            std::fs::remove_dir_all(&backup_path)?;
        }

        // Reload the database with new data
        self.store = MmapVectorStore::open(&self.path, self.config.dimensions)?;
        *self.index.write() = new_index;
        *self.id_map.write() = new_id_map;
        *self.reverse_id_map.write() = new_reverse_map;
        self.deleted.write().clear();

        let duration_ms = start.elapsed().as_millis() as u64;

        // Checkpoint after compaction (all prior records are now in compacted files)
        // This ensures WAL is truncated and ready for new operations
        self.flush()?;

        Ok(CompactionResult {
            vectors_removed: deleted_count,
            vectors_kept: active_count,
            bytes_reclaimed: bytes_reclaimed as u64,
            duration_ms,
        })
    }

    /// Check if compaction is recommended
    ///
    /// Returns true if:
    /// - At least 20% of vectors are deleted, AND
    /// - At least 100 vectors are deleted (to avoid compacting tiny databases)
    pub fn should_compact(&self) -> bool {
        let deleted = self.deleted.read();
        let deleted_count = deleted.len() as usize;
        let total_count = self.store.len();

        if total_count == 0 {
            return false;
        }

        let deleted_ratio = deleted_count as f64 / total_count as f64;
        deleted_ratio >= 0.2 && deleted_count >= 100
    }

    /// Remove edges pointing to deleted nodes from HNSW graph
    ///
    /// This is a lightweight operation that improves search quality
    /// without the cost of full compaction. Does NOT reclaim disk space.
    ///
    /// Returns the number of edges removed.
    pub fn cleanup_edges(&mut self) -> Result<usize> {
        let deleted = self.deleted.read();
        let mut index = self.index.write();
        let edges_removed = index.cleanup_deleted_edges(&deleted);
        Ok(edges_removed)
    }

    /// Check if there's enough disk space for compaction
    ///
    /// Compaction uses copy-then-swap, so it needs approximately 2x the current
    /// database size during the operation.
    pub(crate) fn check_disk_space_for_compaction(&self) -> Result<()> {
        // Calculate current database size
        let vectors_file = self.path.join("vectors.bin");
        let hnsw_file = self.path.join("hnsw.db");
        let idmap_file = self.path.join("idmap.db");

        let mut current_size: u64 = 0;

        if vectors_file.exists() {
            current_size += std::fs::metadata(&vectors_file)?.len();
        }
        if hnsw_file.exists() {
            current_size += std::fs::metadata(&hnsw_file)?.len();
        }
        if idmap_file.exists() {
            current_size += std::fs::metadata(&idmap_file)?.len();
        }

        // We need approximately the same space for the new files, plus some buffer
        let required = current_size + (current_size / 10); // 10% buffer

        let available = filesystem_available_bytes(&self.path)?;

        if available < required {
            return Err(EmbedDbError::InsufficientSpace {
                required,
                available,
            });
        }

        Ok(())
    }

    /// Start compaction in background, allowing concurrent reads
    ///
    /// Returns a handle that can be used to check progress or wait for completion.
    /// Writes are blocked during compaction (due to the copy-then-swap nature).
    /// Reads continue using the old data until the swap completes.
    ///
    /// # Example
    /// ```ignore
    /// let handle = db.compact_async()?;
    /// while !handle.is_complete() {
    ///     println!("Progress: {:.0}%", handle.progress() * 100.0);
    ///     std::thread::sleep(std::time::Duration::from_millis(100));
    /// }
    /// let result = handle.wait()?;
    /// ```
    pub fn compact_async(db: Arc<RwLock<EmbeddingDb>>) -> Result<CompactionHandle> {
        // Get initial state from the database
        let (_path, config, deleted_count, _total_count, active_count) = {
            let db_read = db.read();
            let deleted = db_read.deleted.read();
            let deleted_count = deleted.len() as usize;
            let total_count = db_read.store.len();
            let active_count = total_count - deleted_count;
            (
                db_read.path.clone(),
                db_read.config.clone(),
                deleted_count,
                total_count,
                active_count,
            )
        };

        // Nothing to compact
        if deleted_count == 0 {
            let state = Arc::new(CompactionState::new(0));
            state.set_complete(Ok(CompactionResult {
                vectors_removed: 0,
                vectors_kept: active_count,
                bytes_reclaimed: 0,
                duration_ms: 0,
            }));
            return Ok(CompactionHandle {
                state,
                thread_handle: None,
            });
        }

        // Check disk space before starting
        {
            let db_read = db.read();
            db_read.check_disk_space_for_compaction()?;
        }

        // Create shared state for progress tracking
        let state = Arc::new(CompactionState::new(active_count as u64));
        let state_clone = Arc::clone(&state);
        let db_clone = Arc::clone(&db);

        let thread_handle = std::thread::spawn(move || {
            let result = Self::do_compact_async(db_clone, state_clone.clone(), config.clone());
            state_clone.set_complete(result);
        });

        Ok(CompactionHandle {
            state,
            thread_handle: Some(thread_handle),
        })
    }

    /// Internal implementation of async compaction
    fn do_compact_async(
        db: Arc<RwLock<EmbeddingDb>>,
        state: Arc<CompactionState>,
        config: Config,
    ) -> Result<CompactionResult> {
        let start = std::time::Instant::now();

        // Read data we need from the database (minimize lock time)
        let (path, deleted_clone, reverse_map_clone, total_count, active_count) = {
            let db_read = db.read();
            let deleted = db_read.deleted.read().clone();
            let reverse_map = db_read.reverse_id_map.read().clone();
            let total_count = db_read.store.len();
            let deleted_count = deleted.len() as usize;
            (
                db_read.path.clone(),
                deleted,
                reverse_map,
                total_count,
                total_count - deleted_count,
            )
        };

        let deleted_count = total_count - active_count;
        let bytes_per_vector = config.dimensions * 4;
        let bytes_reclaimed = deleted_count * bytes_per_vector;

        // Create temp directory for new files
        let temp_path = path.join(".compact_temp");
        if temp_path.exists() {
            std::fs::remove_dir_all(&temp_path)?;
        }
        std::fs::create_dir_all(&temp_path)?;

        // Create new vector store
        let mut new_store = MmapVectorStore::open(&temp_path, config.dimensions)?;

        // Create new HNSW index
        let hnsw_config = HnswConfig::new(config.m, config.ef_construction, config.ef_search);
        let mut new_index = HnswIndex::new(hnsw_config);

        // Build mappings: old internal ID → new internal ID
        let mut new_id_map: HashMap<String, usize> = HashMap::with_capacity(active_count);
        let mut new_reverse_map: HashMap<usize, String> = HashMap::with_capacity(active_count);

        let mut processed: u64 = 0;

        // Copy non-deleted vectors (need read lock for vector access)
        for old_internal_id in 0..total_count {
            // Skip deleted vectors
            if deleted_clone.contains(old_internal_id as u32) {
                continue;
            }

            // Get the vector (need brief read lock)
            let vector = {
                let db_read = db.read();
                db_read.store.get(old_internal_id).map(|v| v.to_vec())
            };

            let vector = match vector {
                Some(v) => v,
                None => continue,
            };

            // Get the external ID
            let external_id = match reverse_map_clone.get(&old_internal_id) {
                Some(id) => id.clone(),
                None => continue,
            };

            // Append to new store
            let new_internal_id = new_store.append(&vector)?;

            // Update mappings
            new_id_map.insert(external_id.clone(), new_internal_id);
            new_reverse_map.insert(new_internal_id, external_id);

            // Insert into new HNSW index
            new_index.insert(new_internal_id, &vector, &new_store);

            // Update progress
            processed += 1;
            state.update_progress(processed);
        }

        // Save new index and id map to temp directory
        new_store.flush()?;
        new_index.save(&temp_path)?;

        let new_id_map_data = IdMapData {
            id_map: new_id_map.clone(),
            reverse_map: new_reverse_map.clone(),
            deleted: RoaringBitmap::new(),
        };
        new_id_map_data.save(&temp_path)?;

        // Now we need exclusive access to swap files
        let mut db_write = db.write();

        // Atomic swap: rename old files to backup, then temp to main
        let backup_path = path.join(".compact_backup");
        if backup_path.exists() {
            std::fs::remove_dir_all(&backup_path)?;
        }

        // Move current files to backup
        db_write.move_db_files(&path, &backup_path)?;

        // Move new files to main path
        db_write.move_db_files(&temp_path, &path)?;

        // Clean up temp and backup directories
        if temp_path.exists() {
            std::fs::remove_dir_all(&temp_path)?;
        }
        if backup_path.exists() {
            std::fs::remove_dir_all(&backup_path)?;
        }

        // Reload the database with new data
        db_write.store = MmapVectorStore::open(&path, config.dimensions)?;
        *db_write.index.write() = new_index;
        *db_write.id_map.write() = new_id_map;
        *db_write.reverse_id_map.write() = new_reverse_map;
        db_write.deleted.write().clear();

        let duration_ms = start.elapsed().as_millis() as u64;

        Ok(CompactionResult {
            vectors_removed: deleted_count,
            vectors_kept: active_count,
            bytes_reclaimed: bytes_reclaimed as u64,
            duration_ms,
        })
    }

    /// Move database files from one directory to another
    fn move_db_files(&self, from: &Path, to: &Path) -> Result<()> {
        std::fs::create_dir_all(to)?;

        let files = ["vectors.bin", "hnsw.db", "idmap.db"];
        for file in &files {
            let src = from.join(file);
            let dst = to.join(file);
            if src.exists() {
                std::fs::rename(&src, &dst)?;
            }
        }

        Ok(())
    }

    /// Recover from interrupted compaction
    ///
    /// Called automatically on open. Handles:
    /// - Incomplete compaction (temp dir exists): clean up temp
    /// - Interrupted swap (backup exists but no main files): restore backup
    pub fn recover_compaction(path: &Path) -> Result<()> {
        let temp_path = path.join(".compact_temp");
        let backup_path = path.join(".compact_backup");
        let vectors_path = path.join("vectors.bin");

        // Case 1: Backup exists but main files don't - interrupted during swap
        if backup_path.exists() && !vectors_path.exists() {
            // Restore from backup
            let files = ["vectors.bin", "hnsw.db", "idmap.db"];
            for file in &files {
                let src = backup_path.join(file);
                let dst = path.join(file);
                if src.exists() {
                    std::fs::rename(&src, &dst)?;
                }
            }
        }

        // Clean up any leftover temp/backup directories
        if temp_path.exists() {
            std::fs::remove_dir_all(&temp_path)?;
        }
        if backup_path.exists() {
            std::fs::remove_dir_all(&backup_path)?;
        }

        Ok(())
    }
}

#[cfg(unix)]
pub(crate) fn filesystem_available_bytes(path: &Path) -> io::Result<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "filesystem path contains a NUL byte",
        )
    })?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    let result = unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    Ok(u64::from(stat.f_bavail).saturating_mul(stat.f_frsize))
}

#[cfg(windows)]
pub(crate) fn filesystem_available_bytes(path: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut available = 0u64;
    let result = unsafe {
        GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(available)
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn filesystem_available_bytes(_path: &Path) -> io::Result<u64> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "filesystem capacity checks are not implemented for this platform",
    ))
}
