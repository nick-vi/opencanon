use super::*;
use std::sync::Arc;
use tempfile::tempdir;

#[test]
fn test_create_and_insert() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
    db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();

    assert_eq!(db.len(), 2);
    assert!(db.contains("doc1"));
    assert!(db.contains("doc2"));
    assert!(!db.contains("doc3"));
}

#[test]
fn test_search() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
    db.insert("doc2", &[0.9, 0.1, 0.0, 0.0]).unwrap();
    db.insert("doc3", &[0.0, 1.0, 0.0, 0.0]).unwrap();

    let results = db.search(&[1.0, 0.0, 0.0, 0.0], 3);

    // Should find results (at least 1)
    assert!(!results.is_empty(), "Should find at least one result");
    // First result should be exact match
    assert_eq!(results[0].id, "doc1", "First result should be exact match");
    assert!(
        (results[0].score - 1.0).abs() < 0.01,
        "Exact match should have score ~1.0, got {}",
        results[0].score
    );
}

#[test]
fn test_delete() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
    db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();

    assert!(db.delete("doc1").unwrap());
    assert!(!db.contains("doc1"));
    assert_eq!(db.len(), 1);

    // Search should not return deleted
    let results = db.search(&[1.0, 0.0, 0.0, 0.0], 10);
    assert!(!results.iter().any(|r| r.id == "doc1"));
}

#[test]
fn test_duplicate_id() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
    let result = db.insert("doc1", &[0.0, 1.0, 0.0, 0.0]);

    assert!(matches!(result, Err(EmbedDbError::DuplicateId(_))));
}

#[test]
fn test_dimension_mismatch() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    let result = db.insert("doc1", &[1.0, 0.0, 0.0]); // 3 instead of 4

    assert!(matches!(
        result,
        Err(EmbedDbError::DimensionMismatch { .. })
    ));
}

#[test]
fn test_get() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    let vector = vec![1.0, 2.0, 3.0, 4.0];
    db.insert("doc1", &vector).unwrap();

    let retrieved = db.get("doc1").unwrap();
    assert_eq!(retrieved, vector);

    assert!(db.get("nonexistent").is_none());
}

#[test]
fn test_persistence_roundtrip() {
    let dir = tempdir().unwrap();

    // Create and populate database
    {
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
        db.insert("doc2", &[0.9, 0.1, 0.0, 0.0]).unwrap();
        db.insert("doc3", &[0.0, 1.0, 0.0, 0.0]).unwrap();
        db.insert("doc4", &[0.0, 0.0, 1.0, 0.0]).unwrap();

        // Delete one
        assert!(db.delete("doc3").unwrap());

        // Flush to disk
        db.flush().unwrap();
    }

    // Reopen and verify
    {
        let db = EmbeddingDb::open(dir.path()).unwrap();

        // Check counts
        assert_eq!(db.len(), 3, "Should have 3 active vectors");

        // Check ID existence
        assert!(db.contains("doc1"));
        assert!(db.contains("doc2"));
        assert!(!db.contains("doc3"), "doc3 should be deleted");
        assert!(db.contains("doc4"));

        // Check vector retrieval
        let v1 = db.get("doc1").unwrap();
        assert_eq!(v1, vec![1.0, 0.0, 0.0, 0.0]);

        // Check search works
        let results = db.search(&[1.0, 0.0, 0.0, 0.0], 5);
        assert!(!results.is_empty(), "Should find results");
        assert_eq!(results[0].id, "doc1", "First result should be doc1");
        assert!(
            (results[0].score - 1.0).abs() < 0.01,
            "Should have score ~1.0"
        );

        // doc3 should not appear in results
        assert!(
            !results.iter().any(|r| r.id == "doc3"),
            "Deleted doc3 should not appear in results"
        );
    }
}

#[test]
fn test_open_empty_directory() {
    let dir = tempdir().unwrap();

    // Open a directory with no existing database
    let db = EmbeddingDb::open(dir.path()).unwrap();

    // Should be empty
    assert_eq!(db.len(), 0);
    assert!(db.is_empty());
}

#[test]
fn test_compact_empty() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    // Compact empty database
    let result = db.compact().unwrap();
    assert_eq!(result.vectors_removed, 0);
    assert_eq!(result.vectors_kept, 0);
}

#[test]
fn test_compact_no_deletions() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
    db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();

    // Compact with no deletions
    let result = db.compact().unwrap();
    assert_eq!(result.vectors_removed, 0);
    assert_eq!(result.vectors_kept, 2);
}

#[test]
fn test_compact_with_deletions() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    // Insert several vectors
    db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
    db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
    db.insert("doc3", &[0.0, 0.0, 1.0, 0.0]).unwrap();
    db.insert("doc4", &[0.0, 0.0, 0.0, 1.0]).unwrap();

    // Delete some
    assert!(db.delete("doc2").unwrap());
    assert!(db.delete("doc3").unwrap());

    // Verify state before compaction
    assert_eq!(db.len(), 2);
    let metrics = db.metrics();
    assert_eq!(metrics.vector_count, 4); // 4 in store
    assert_eq!(metrics.deleted_count, 2); // 2 deleted

    // Compact
    let result = db.compact().unwrap();
    assert_eq!(result.vectors_removed, 2);
    assert_eq!(result.vectors_kept, 2);
    assert_eq!(result.bytes_reclaimed, 2 * 4 * 4); // 2 vectors * 4 dims * 4 bytes

    // Verify state after compaction
    assert_eq!(db.len(), 2);
    let metrics = db.metrics();
    assert_eq!(metrics.vector_count, 2); // Only 2 in store now
    assert_eq!(metrics.deleted_count, 0); // No deletions

    // Verify remaining vectors are accessible
    assert!(db.contains("doc1"));
    assert!(!db.contains("doc2"));
    assert!(!db.contains("doc3"));
    assert!(db.contains("doc4"));

    let v1 = db.get("doc1").unwrap();
    assert_eq!(v1, vec![1.0, 0.0, 0.0, 0.0]);

    let v4 = db.get("doc4").unwrap();
    assert_eq!(v4, vec![0.0, 0.0, 0.0, 1.0]);

    // Search should still work
    let results = db.search(&[1.0, 0.0, 0.0, 0.0], 10);
    assert!(!results.is_empty());
    assert_eq!(results[0].id, "doc1");
}

#[test]
fn test_compact_persistence() {
    let dir = tempdir().unwrap();

    // Create, populate, delete, compact, flush
    {
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

        db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
        db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
        db.insert("doc3", &[0.0, 0.0, 1.0, 0.0]).unwrap();

        db.delete("doc2").unwrap();
        db.compact().unwrap();
        db.flush().unwrap();
    }

    // Reopen and verify
    {
        let db = EmbeddingDb::open(dir.path()).unwrap();

        assert_eq!(db.len(), 2);
        assert!(db.contains("doc1"));
        assert!(!db.contains("doc2"));
        assert!(db.contains("doc3"));

        let metrics = db.metrics();
        assert_eq!(metrics.vector_count, 2);
        assert_eq!(metrics.deleted_count, 0);
    }
}

#[test]
fn test_should_compact() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    // Empty database
    assert!(!db.should_compact());

    // Add some vectors but not enough for threshold
    for i in 0..50 {
        db.insert(&format!("doc{}", i), &[i as f32, 0.0, 0.0, 0.0])
            .unwrap();
    }
    assert!(!db.should_compact());

    // Delete less than 20%
    for i in 0..5 {
        db.delete(&format!("doc{}", i)).unwrap();
    }
    assert!(!db.should_compact()); // 5/50 = 10%, below threshold

    // Add more vectors to reach minimum count
    for i in 50..500 {
        db.insert(&format!("doc{}", i), &[i as f32, 0.0, 0.0, 0.0])
            .unwrap();
    }

    // Delete 20%+ to trigger threshold
    for i in 5..150 {
        db.delete(&format!("doc{}", i)).unwrap();
    }
    // Now we have 150 deleted out of 500 = 30%
    assert!(db.should_compact());
}

#[test]
fn test_compact_recovery_temp_exists() {
    let dir = tempdir().unwrap();

    // Create a database
    {
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
        db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
        db.flush().unwrap();
    }

    // Simulate interrupted compaction by creating temp directory
    let temp_path = dir.path().join(".compact_temp");
    std::fs::create_dir_all(&temp_path).unwrap();
    std::fs::write(temp_path.join("vectors.bin"), b"garbage").unwrap();

    // Open should clean up temp and work normally
    let db = EmbeddingDb::open(dir.path()).unwrap();
    assert_eq!(db.len(), 1);
    assert!(db.contains("doc1"));

    // Temp directory should be cleaned up
    assert!(!temp_path.exists());
}

// ==================== Task 1: Edge Cleanup Tests ====================

#[test]
fn test_cleanup_edges_no_deletions() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
    db.insert("doc2", &[0.9, 0.1, 0.0, 0.0]).unwrap();
    db.insert("doc3", &[0.0, 1.0, 0.0, 0.0]).unwrap();

    // No deletions, should remove 0 edges
    let edges_removed = db.cleanup_edges().unwrap();
    assert_eq!(edges_removed, 0);

    // Search should still work
    let results = db.search(&[1.0, 0.0, 0.0, 0.0], 3);
    assert!(!results.is_empty());
}

#[test]
fn test_cleanup_edges_with_deletions() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    // Insert several vectors so we get edges in HNSW
    db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
    db.insert("doc2", &[0.9, 0.1, 0.0, 0.0]).unwrap();
    db.insert("doc3", &[0.8, 0.2, 0.0, 0.0]).unwrap();
    db.insert("doc4", &[0.0, 1.0, 0.0, 0.0]).unwrap();
    db.insert("doc5", &[0.0, 0.9, 0.1, 0.0]).unwrap();

    // Delete some vectors
    db.delete("doc2").unwrap();
    db.delete("doc4").unwrap();

    // cleanup_edges should remove edges pointing to deleted nodes
    let _edges_removed = db.cleanup_edges().unwrap();
    // We can't predict exact count, just verify it succeeds

    // Search should still work and not return deleted vectors
    let results = db.search(&[1.0, 0.0, 0.0, 0.0], 10);
    assert!(!results.iter().any(|r| r.id == "doc2"));
    assert!(!results.iter().any(|r| r.id == "doc4"));

    // Active vectors should still be findable
    assert!(results.iter().any(|r| r.id == "doc1"));
}

#[test]
fn test_cleanup_edges_empty_db() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    // Should not error on empty database
    let edges_removed = db.cleanup_edges().unwrap();
    assert_eq!(edges_removed, 0);
}

// ==================== Task 2: Disk Space Check Tests ====================

#[test]
fn test_disk_space_check_passes() {
    let dir = tempdir().unwrap();
    let db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    // Should not error - we have plenty of space for a tiny database
    let result = db.check_disk_space_for_compaction();
    assert!(result.is_ok());
}

#[test]
fn test_disk_space_check_reports_inspection_failure() {
    let dir = tempdir().unwrap();
    let missing = dir.path().join("missing");

    assert!(crate::compaction::filesystem_available_bytes(&missing).is_err());
}

#[test]
fn test_insufficient_space_error() {
    // Test that the error type exists and formats correctly
    let err = EmbedDbError::InsufficientSpace {
        required: 1000,
        available: 500,
    };
    let msg = format!("{}", err);
    assert!(msg.contains("1000"));
    assert!(msg.contains("500"));
}

// ==================== Task 3: Async Compaction Tests ====================

#[test]
fn test_compact_async_empty() {
    let dir = tempdir().unwrap();
    let db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
    let db = Arc::new(RwLock::new(db));

    // Compact empty database
    let handle = EmbeddingDb::compact_async(db.clone()).unwrap();

    // Should complete immediately
    assert!(handle.is_complete());
    assert!((handle.progress() - 1.0).abs() < 0.01);

    let result = handle.wait().unwrap();
    assert_eq!(result.vectors_removed, 0);
    assert_eq!(result.vectors_kept, 0);
}

#[test]
fn test_compact_async_no_deletions() {
    let dir = tempdir().unwrap();
    let db = Arc::new(RwLock::new(
        EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap(),
    ));

    // Insert vectors
    {
        let mut db_write = db.write();
        db_write.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
        db_write.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
    }

    // Compact with no deletions
    let handle = EmbeddingDb::compact_async(db.clone()).unwrap();
    let result = handle.wait().unwrap();

    assert_eq!(result.vectors_removed, 0);
    assert_eq!(result.vectors_kept, 2);
}

#[test]
fn test_compact_async_with_deletions() {
    let dir = tempdir().unwrap();
    let db = Arc::new(RwLock::new(
        EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap(),
    ));

    // Insert and delete
    {
        let mut db_write = db.write();
        db_write.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
        db_write.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
        db_write.insert("doc3", &[0.0, 0.0, 1.0, 0.0]).unwrap();
        db_write.insert("doc4", &[0.0, 0.0, 0.0, 1.0]).unwrap();
        db_write.delete("doc2").unwrap();
        db_write.delete("doc3").unwrap();
    }

    // Start async compaction
    let handle = EmbeddingDb::compact_async(db.clone()).unwrap();

    // Wait for completion
    let result = handle.wait().unwrap();

    assert_eq!(result.vectors_removed, 2);
    assert_eq!(result.vectors_kept, 2);

    // Verify database state after compaction
    {
        let db_read = db.read();
        assert_eq!(db_read.len(), 2);
        assert!(db_read.contains("doc1"));
        assert!(!db_read.contains("doc2"));
        assert!(!db_read.contains("doc3"));
        assert!(db_read.contains("doc4"));
    }
}

#[test]
fn test_compact_async_progress() {
    let dir = tempdir().unwrap();
    let db = Arc::new(RwLock::new(
        EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap(),
    ));

    // Insert more vectors for observable progress
    {
        let mut db_write = db.write();
        for i in 0..20 {
            db_write
                .insert(&format!("doc{}", i), &[i as f32, 0.0, 0.0, 0.0])
                .unwrap();
        }
        // Delete some
        for i in 0..5 {
            db_write.delete(&format!("doc{}", i)).unwrap();
        }
    }

    let handle = EmbeddingDb::compact_async(db.clone()).unwrap();

    // Progress should be between 0 and 1
    let progress = handle.progress();
    assert!((0.0..=1.0).contains(&progress));

    // Wait and verify
    let result = handle.wait().unwrap();
    assert_eq!(result.vectors_removed, 5);
    assert_eq!(result.vectors_kept, 15);
}

#[test]
fn test_compact_async_reads_during_compaction() {
    let dir = tempdir().unwrap();
    let db = Arc::new(RwLock::new(
        EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap(),
    ));

    // Insert vectors
    {
        let mut db_write = db.write();
        for i in 0..10 {
            db_write
                .insert(&format!("doc{}", i), &[i as f32, 0.0, 0.0, 0.0])
                .unwrap();
        }
        for i in 0..3 {
            db_write.delete(&format!("doc{}", i)).unwrap();
        }
    }

    // Start compaction
    let handle = EmbeddingDb::compact_async(db.clone()).unwrap();

    // While compaction is running, we should still be able to read
    // (though the data might be stale until swap completes)
    {
        let db_read = db.read();
        // Just verify we can access the database
        let _len = db_read.len();
    }

    // Wait for completion
    let result = handle.wait().unwrap();
    assert_eq!(result.vectors_removed, 3);
    assert_eq!(result.vectors_kept, 7);

    // Verify final state
    {
        let db_read = db.read();
        assert_eq!(db_read.len(), 7);
    }
}

// ==================== Batch Insert Tests ====================

#[test]
fn test_batch_insert() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    let ids = vec!["doc1".to_string(), "doc2".to_string(), "doc3".to_string()];
    let vectors = vec![
        vec![1.0, 0.0, 0.0, 0.0],
        vec![0.0, 1.0, 0.0, 0.0],
        vec![0.0, 0.0, 1.0, 0.0],
    ];

    db.insert_batch(&ids, &vectors).unwrap();

    assert_eq!(db.len(), 3);
    assert!(db.contains("doc1"));
    assert!(db.contains("doc2"));
    assert!(db.contains("doc3"));

    // Verify vectors are retrievable
    assert_eq!(db.get("doc1").unwrap(), vec![1.0, 0.0, 0.0, 0.0]);
    assert_eq!(db.get("doc2").unwrap(), vec![0.0, 1.0, 0.0, 0.0]);
    assert_eq!(db.get("doc3").unwrap(), vec![0.0, 0.0, 1.0, 0.0]);
}

#[test]
fn test_batch_insert_searchable() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    let ids = vec!["doc1".to_string(), "doc2".to_string(), "doc3".to_string()];
    let vectors = vec![
        vec![1.0, 0.0, 0.0, 0.0],
        vec![0.9, 0.1, 0.0, 0.0],
        vec![0.0, 1.0, 0.0, 0.0],
    ];

    db.insert_batch(&ids, &vectors).unwrap();

    // Search should work
    let results = db.search(&[1.0, 0.0, 0.0, 0.0], 3);
    assert!(!results.is_empty());
    assert_eq!(results[0].id, "doc1");
}

#[test]
fn test_batch_insert_empty() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    db.insert_batch(&[], &[]).unwrap();
    assert_eq!(db.len(), 0);
}

#[test]
fn test_batch_insert_duplicate_existing() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    // Insert one first
    db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();

    // Try batch with duplicate
    let ids = vec!["doc1".to_string(), "doc2".to_string()];
    let vectors = vec![vec![0.0, 1.0, 0.0, 0.0], vec![0.0, 0.0, 1.0, 0.0]];

    let result = db.insert_batch(&ids, &vectors);
    assert!(matches!(result, Err(EmbedDbError::DuplicateId(_))));

    // Database should be unchanged
    assert_eq!(db.len(), 1);
}

#[test]
fn test_batch_insert_duplicate_within_batch() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    let ids = vec![
        "doc1".to_string(),
        "doc2".to_string(),
        "doc1".to_string(), // Duplicate!
    ];
    let vectors = vec![
        vec![1.0, 0.0, 0.0, 0.0],
        vec![0.0, 1.0, 0.0, 0.0],
        vec![0.0, 0.0, 1.0, 0.0],
    ];

    let result = db.insert_batch(&ids, &vectors);
    assert!(matches!(result, Err(EmbedDbError::DuplicateId(_))));

    // Database should be unchanged
    assert_eq!(db.len(), 0);
}

#[test]
fn test_batch_insert_dimension_mismatch() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    let ids = vec!["doc1".to_string(), "doc2".to_string()];
    let vectors = vec![
        vec![1.0, 0.0, 0.0, 0.0],
        vec![0.0, 1.0, 0.0], // Wrong dimension!
    ];

    let result = db.insert_batch(&ids, &vectors);
    assert!(matches!(
        result,
        Err(EmbedDbError::DimensionMismatch { .. })
    ));

    // Database should be unchanged
    assert_eq!(db.len(), 0);
}

#[test]
fn test_batch_insert_length_mismatch() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    let ids = vec!["doc1".to_string(), "doc2".to_string()];
    let vectors = vec![vec![1.0, 0.0, 0.0, 0.0]]; // Only one vector!

    let result = db.insert_batch(&ids, &vectors);
    assert!(result.is_err());
}

#[test]
fn test_batch_insert_mixed_with_single() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    // Single insert first
    db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();

    // Batch insert
    let ids = vec!["doc2".to_string(), "doc3".to_string()];
    let vectors = vec![vec![0.0, 1.0, 0.0, 0.0], vec![0.0, 0.0, 1.0, 0.0]];
    db.insert_batch(&ids, &vectors).unwrap();

    // Single insert after
    db.insert("doc4", &[0.0, 0.0, 0.0, 1.0]).unwrap();

    assert_eq!(db.len(), 4);

    // All should be searchable
    let results = db.search(&[1.0, 0.0, 0.0, 0.0], 4);
    assert_eq!(results.len(), 4);
}

#[test]
fn test_batch_insert_persistence() {
    let dir = tempdir().unwrap();

    // Create and batch insert
    {
        let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
        let ids = vec!["doc1".to_string(), "doc2".to_string()];
        let vectors = vec![vec![1.0, 0.0, 0.0, 0.0], vec![0.0, 1.0, 0.0, 0.0]];
        db.insert_batch(&ids, &vectors).unwrap();
        db.flush().unwrap();
    }

    // Reopen and verify
    {
        let db = EmbeddingDb::open(dir.path()).unwrap();
        assert_eq!(db.len(), 2);
        assert!(db.contains("doc1"));
        assert!(db.contains("doc2"));
        assert_eq!(db.get("doc1").unwrap(), vec![1.0, 0.0, 0.0, 0.0]);

        // Search should work
        let results = db.search(&[1.0, 0.0, 0.0, 0.0], 2);
        assert!(!results.is_empty());
    }
}

#[test]
fn test_batch_insert_large() {
    let dir = tempdir().unwrap();
    let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

    // Insert 100 vectors in a batch - use orthogonal vectors for reliable search
    let ids: Vec<String> = (0..100).map(|i| format!("doc{}", i)).collect();
    let vectors: Vec<Vec<f32>> = (0..100)
        .map(|i| {
            // Create more distinguishable vectors using different components
            let angle = (i as f32) * std::f32::consts::PI * 2.0 / 100.0;
            vec![angle.cos(), angle.sin(), 0.0, 0.0]
        })
        .collect();

    db.insert_batch(&ids, &vectors).unwrap();

    assert_eq!(db.len(), 100);

    // Spot check some vectors
    assert!(db.contains("doc0"));
    assert!(db.contains("doc50"));
    assert!(db.contains("doc99"));

    // Search should find a result (not testing exact match since HNSW is approximate)
    let results = db.search(&vectors[50], 5);
    assert!(!results.is_empty());
    // The exact match should be in top results
    assert!(
        results.iter().any(|r| r.id == "doc50"),
        "doc50 should be in search results, got: {:?}",
        results.iter().map(|r| &r.id).collect::<Vec<_>>()
    );
}

// ==================== WAL Integration Tests ====================

#[cfg(feature = "wal")]
mod wal_integration_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_wal_crash_recovery_insert() {
        let dir = tempdir().unwrap();

        // Insert records but DON'T flush
        {
            let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
            db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
            db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
            db.insert("doc3", &[0.0, 0.0, 1.0, 0.0]).unwrap();
            // Simulate crash by dropping without flush
        }

        // Reopen - WAL should replay
        {
            let db = EmbeddingDb::open(dir.path()).unwrap();
            assert_eq!(db.len(), 3);
            assert!(db.contains("doc1"));
            assert!(db.contains("doc2"));
            assert!(db.contains("doc3"));
            assert_eq!(db.get("doc1").unwrap(), vec![1.0, 0.0, 0.0, 0.0]);
        }
    }

    #[test]
    fn test_wal_crash_recovery_batch_insert() {
        let dir = tempdir().unwrap();

        // Batch insert without flush
        {
            let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
            let ids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
            let vectors = vec![
                vec![1.0, 0.0, 0.0, 0.0],
                vec![0.0, 1.0, 0.0, 0.0],
                vec![0.0, 0.0, 1.0, 0.0],
            ];
            db.insert_batch(&ids, &vectors).unwrap();
            // Crash without flush
        }

        // Reopen - WAL should replay batch
        {
            let db = EmbeddingDb::open(dir.path()).unwrap();
            assert_eq!(db.len(), 3);
            assert!(db.contains("a"));
            assert!(db.contains("b"));
            assert!(db.contains("c"));
        }
    }

    #[test]
    fn test_wal_crash_recovery_delete() {
        let dir = tempdir().unwrap();

        // Insert then delete without flush
        {
            let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
            db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
            db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
            db.delete("doc1").unwrap();
            // Crash without flush
        }

        // Reopen - WAL should replay insert and delete
        {
            let db = EmbeddingDb::open(dir.path()).unwrap();
            assert_eq!(db.len(), 1);
            assert!(!db.contains("doc1"), "doc1 should be deleted");
            assert!(db.contains("doc2"));
        }
    }

    #[test]
    fn test_wal_normal_operation_with_flush() {
        let dir = tempdir().unwrap();

        // Insert and flush
        {
            let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
            db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
            db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
            db.flush().unwrap();
        }

        // Reopen and verify
        {
            let db = EmbeddingDb::open(dir.path()).unwrap();
            assert_eq!(db.len(), 2);
            assert!(db.contains("doc1"));
            assert!(db.contains("doc2"));
        }

        // Add more data after reopen
        {
            let mut db = EmbeddingDb::open(dir.path()).unwrap();
            db.insert("doc3", &[0.0, 0.0, 1.0, 0.0]).unwrap();
            // Crash without flush
        }

        // Reopen - should have doc1, doc2 from checkpoint + doc3 from WAL
        {
            let db = EmbeddingDb::open(dir.path()).unwrap();
            assert_eq!(db.len(), 3);
            assert!(db.contains("doc1"));
            assert!(db.contains("doc2"));
            assert!(db.contains("doc3"));
        }
    }

    #[test]
    fn test_wal_checkpoint_truncates_wal() {
        let dir = tempdir().unwrap();

        {
            let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

            // Insert some records
            for i in 0..10 {
                db.insert(&format!("doc{}", i), &[i as f32, 0.0, 0.0, 0.0])
                    .unwrap();
            }

            // Flush should checkpoint and truncate WAL
            db.flush().unwrap();
        }

        // Reopen and verify
        {
            let db = EmbeddingDb::open(dir.path()).unwrap();
            assert_eq!(db.len(), 10);
        }
    }

    #[test]
    fn test_wal_disabled() {
        let dir = tempdir().unwrap();

        // Create with WAL disabled
        {
            let config = Config::with_dimensions(4).without_wal();
            let mut db = EmbeddingDb::create(dir.path(), config).unwrap();
            db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
            // No flush - data will be lost
        }

        // Reopen - should be empty (no WAL to recover from, no flush)
        {
            let config = Config::with_dimensions(4).without_wal();
            let _db = EmbeddingDb::open_with_config(dir.path(), Some(config)).unwrap();
            // Data might or might not be there depending on mmap behavior
            // The important thing is no crash
        }
    }

    #[test]
    fn test_wal_idempotent_recovery() {
        let dir = tempdir().unwrap();

        // Insert records
        {
            let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
            db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
            db.insert("doc2", &[0.0, 1.0, 0.0, 0.0]).unwrap();
        }

        // Reopen multiple times - should be idempotent
        for _ in 0..3 {
            let db = EmbeddingDb::open(dir.path()).unwrap();
            assert_eq!(db.len(), 2);
            assert!(db.contains("doc1"));
            assert!(db.contains("doc2"));
        }
    }

    #[test]
    fn test_wal_compaction_coordination() {
        let dir = tempdir().unwrap();

        {
            let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();

            // Insert and delete some vectors
            for i in 0..10 {
                db.insert(&format!("doc{}", i), &[i as f32, 0.0, 0.0, 0.0])
                    .unwrap();
            }
            for i in 0..5 {
                db.delete(&format!("doc{}", i)).unwrap();
            }

            // Compact should checkpoint before and after
            db.compact().unwrap();

            assert_eq!(db.len(), 5);
        }

        // Reopen and verify
        {
            let db = EmbeddingDb::open(dir.path()).unwrap();
            assert_eq!(db.len(), 5);
            for i in 5..10 {
                assert!(db.contains(&format!("doc{}", i)));
            }
        }
    }

    #[test]
    fn test_wal_search_after_recovery() {
        let dir = tempdir().unwrap();

        // Insert without flush
        {
            let mut db = EmbeddingDb::create(dir.path(), Config::with_dimensions(4)).unwrap();
            db.insert("doc1", &[1.0, 0.0, 0.0, 0.0]).unwrap();
            db.insert("doc2", &[0.9, 0.1, 0.0, 0.0]).unwrap();
            db.insert("doc3", &[0.0, 1.0, 0.0, 0.0]).unwrap();
        }

        // Reopen and search
        {
            let db = EmbeddingDb::open(dir.path()).unwrap();
            let results = db.search(&[1.0, 0.0, 0.0, 0.0], 3);
            assert!(!results.is_empty());
            assert_eq!(results[0].id, "doc1");
        }
    }
}
