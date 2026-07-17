use opencanon_vector::{Config as VectorConfig, EmbeddingDb};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::{Seek, SeekFrom, Write};

use super::support::*;

fn complete_semantic_request() -> Value {
    json!({
        "index": {
            "id": "project",
            "version": "semantic-index-v3",
            "status": "ready",
            "provider": {
                "id": "opencanon-gguf-test",
                "kind": "gguf",
                "modelId": "test-gguf-embedding-2",
                "dimensions": 2,
                "distance": "cosine",
                "configHash": "config"
            },
            "chunkerVersion": "chunker",
            "producerVersion": "producer",
            "sourceInventoryHash": "inventory",
            "chunkTreeHash": "tree",
            "identityHash": "identity",
            "chunkCount": 2,
            "vectorCount": 2,
            "staleChunkCount": 0,
            "indexedAt": "2026-06-06T00:00:00.000Z",
            "diagnostics": []
        },
        "chunks": [
            {
                "metadata": {
                    "id": "chunk:one",
                    "path": "src/one.ts",
                    "contentHash": "content-one",
                    "chunkHash": "chunk-one",
                    "embeddingHash": "embedding-one",
                    "kind": "file",
                    "language": "typescript",
                    "ordinal": 0,
                    "range": {
                        "start": { "line": 1, "column": 1, "byte": 0 },
                        "end": { "line": 1, "column": 10, "byte": 10 }
                    },
                    "tokenCount": 2,
                    "preview": "first chunk"
                },
                "text": "first chunk",
                "vector": [1.0, 0.0]
            },
            {
                "metadata": {
                    "id": "chunk:two",
                    "path": "src/two.ts",
                    "contentHash": "content-two",
                    "chunkHash": "chunk-two",
                    "embeddingHash": "embedding-two",
                    "kind": "file",
                    "language": "typescript",
                    "ordinal": 0,
                    "range": {
                        "start": { "line": 1, "column": 1, "byte": 0 },
                        "end": { "line": 1, "column": 10, "byte": 10 }
                    },
                    "tokenCount": 2,
                    "preview": "second chunk"
                },
                "text": "second chunk",
                "vector": [0.0, 1.0]
            }
        ]
    })
}

#[test]
fn full_write_replaces_an_incomplete_store_with_the_same_identity() {
    let root = test_root("semantic-vector-complete-publication");
    let project = open_test_project(&root);
    let request = complete_semantic_request();
    project
        .write_semantic_index_json(request.to_string())
        .unwrap();

    let vector_dir = root.join(".opencanon/state/test/semantic-index/project");
    let mut db =
        EmbeddingDb::open_with_config(&vector_dir, Some(VectorConfig::with_dimensions(2))).unwrap();
    db.delete("chunk:two").unwrap();
    db.flush().unwrap();
    drop(db);

    let stale: Value = serde_json::from_str(
        &project
            .read_semantic_index_status_json(json!({ "indexId": "project" }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(stale["index"]["status"], "stale");

    project
        .write_semantic_index_json(request.to_string())
        .unwrap();
    let ready: Value = serde_json::from_str(
        &project
            .read_semantic_index_status_json(json!({ "indexId": "project" }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(ready["index"]["status"], "ready");
    assert_eq!(ready["index"]["vectorCount"], 2);
    let repaired =
        EmbeddingDb::open_with_config(&vector_dir, Some(VectorConfig::with_dimensions(2))).unwrap();
    assert_eq!(repaired.len(), 2);
}

#[test]
fn publication_identity_and_pending_state_gate_semantic_reads() {
    let root = test_root("semantic-vector-publication-marker");
    let project = open_test_project(&root);
    let request = complete_semantic_request();
    project
        .write_semantic_index_json(request.to_string())
        .unwrap();

    let vector_parent = root.join(".opencanon/state/test/semantic-index");
    std::fs::remove_file(vector_parent.join("project/publication.json")).unwrap();
    let stale: Value = serde_json::from_str(
        &project
            .read_semantic_index_status_json(json!({ "indexId": "project" }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(stale["index"]["status"], "stale");
    let search_error = project
        .search_semantic_index_json(
            json!({ "indexId": "project", "vector": [1.0, 0.0] }).to_string(),
        )
        .unwrap_err();
    assert!(search_error
        .to_string()
        .contains("publication identity is missing"));

    project
        .write_semantic_index_json(request.to_string())
        .unwrap();
    std::fs::write(vector_parent.join(".project.pending.json"), "{}").unwrap();
    let interrupted: Value = serde_json::from_str(
        &project
            .read_semantic_index_status_json(json!({ "indexId": "project" }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(interrupted["index"]["status"], "stale");
    assert!(interrupted["index"]["diagnostics"][0]["message"]
        .as_str()
        .unwrap()
        .contains("interrupted"));

    project
        .write_semantic_index_json(request.to_string())
        .unwrap();
    assert!(!vector_parent.join(".project.pending.json").exists());
}

#[test]
fn obsolete_vector_format_is_stale_and_full_write_rebuilds_it() {
    let root = test_root("semantic-vector-format");
    let project = open_test_project(&root);
    let request = json!({
        "index": {
            "id": "project",
            "version": "semantic-index-v3",
            "status": "ready",
            "provider": {
                "id": "opencanon-gguf-test",
                "kind": "gguf",
                "modelId": "test-gguf-embedding-2",
                "dimensions": 2,
                "distance": "cosine",
                "configHash": "config"
            },
            "chunkerVersion": "chunker",
            "producerVersion": "producer",
            "sourceInventoryHash": "inventory",
            "chunkTreeHash": "tree",
            "identityHash": "identity",
            "chunkCount": 1,
            "vectorCount": 1,
            "staleChunkCount": 0,
            "indexedAt": "2026-06-06T00:00:00.000Z",
            "diagnostics": []
        },
        "chunks": [{
            "metadata": {
                "id": "chunk:one",
                "path": "src/company.ts",
                "contentHash": "content-one",
                "chunkHash": "chunk-one",
                "embeddingHash": "embedding-one",
                "kind": "file",
                "language": "typescript",
                "ordinal": 0,
                "range": {
                    "start": { "line": 1, "column": 1, "byte": 0 },
                    "end": { "line": 1, "column": 10, "byte": 10 }
                },
                "tokenCount": 2,
                "preview": "active company"
            },
            "text": "active company",
            "vector": [1.0, 0.0]
        }]
    });
    project
        .write_semantic_index_json(request.to_string())
        .unwrap();

    let vector_path = root.join(".opencanon/state/test/semantic-index/project/vectors.bin");
    let mut vectors = OpenOptions::new().write(true).open(&vector_path).unwrap();
    vectors.seek(SeekFrom::Start(4)).unwrap();
    vectors.write_all(&1u32.to_le_bytes()).unwrap();
    vectors.sync_all().unwrap();

    let stale: Value = serde_json::from_str(
        &project
            .read_semantic_index_status_json(json!({ "indexId": "project" }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(stale["index"]["status"], "stale");
    assert_eq!(stale["index"]["vectorCount"], 0);
    assert_eq!(
        stale["index"]["diagnostics"][0]["code"],
        "semantic-vector-rebuild-required"
    );

    project
        .write_semantic_index_json(request.to_string())
        .unwrap();
    let ready: Value = serde_json::from_str(
        &project
            .read_semantic_index_status_json(json!({ "indexId": "project" }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(ready["index"]["status"], "ready");
    assert_eq!(ready["index"]["vectorCount"], 1);
}

#[test]
fn knowledge_index_round_trips_metadata_and_searches_vectors() {
    let root = test_root("semantic-index");
    let project = open_test_project(&root);

    project
        .write_semantic_index_json(
            json!({
                "index": {
                    "id": "project",
                    "version": "semantic-index-v3",
                    "status": "ready",
                    "provider": {
                        "id": "opencanon-gguf-test",
                        "kind": "gguf",
                        "modelId": "test-gguf-embedding-2",
                        "dimensions": 2,
                        "distance": "cosine",
                        "configHash": "config"
                    },
                    "chunkerVersion": "chunker",
                    "producerVersion": "producer",
                    "sourceInventoryHash": "inventory",
                    "chunkTreeHash": "chunk-tree-one",
                    "identityHash": "identity",
                    "chunkCount": 2,
                    "vectorCount": 2,
                    "staleChunkCount": 0,
                    "embeddingStats": {
                        "totalChunks": 2,
                        "embeddedChunks": 2,
                        "reusedChunks": 0,
                        "filesScanned": 2,
                        "filesChanged": 2,
                        "filesDeleted": 0,
                        "chunksAdded": 2,
                        "chunksChanged": 0,
                        "chunksRemoved": 0,
                        "vectorsWritten": 2,
                        "vectorsReused": 0
                    },
                    "indexedAt": "2026-06-06T00:00:00.000Z",
                    "diagnostics": []
                },
                "chunks": [
                    {
                        "metadata": {
                            "id": "chunk:one",
                            "path": "src/company.ts",
                            "contentHash": "content-one",
                            "chunkHash": "chunk-one",
                            "embeddingHash": "embedding-one",
                            "kind": "file",
                            "language": "typescript",
                            "ordinal": 0,
                            "range": {
                                "start": { "line": 1, "column": 1, "byte": 0 },
                                "end": { "line": 1, "column": 10, "byte": 10 }
                            },
                            "tokenCount": 2,
                            "preview": "active company"
                        },
                        "text": "active company billing loader",
                        "vector": [1.0, 0.0]
                    },
                    {
                        "metadata": {
                            "id": "chunk:two",
                            "path": "src/other.ts",
                            "contentHash": "content-two",
                            "chunkHash": "chunk-two",
                            "embeddingHash": "embedding-two",
                            "kind": "file",
                            "language": "typescript",
                            "ordinal": 0,
                            "range": {
                                "start": { "line": 1, "column": 1, "byte": 0 },
                                "end": { "line": 1, "column": 10, "byte": 10 }
                            },
                            "tokenCount": 2,
                            "preview": "other record"
                        },
                        "text": "other record",
                        "vector": [0.0, 1.0]
                    }
                ]
            })
            .to_string(),
        )
        .unwrap();

    let status = project
        .read_semantic_index_status_json(json!({ "indexId": "project" }).to_string())
        .unwrap();
    let status: Value = serde_json::from_str(&status).unwrap();
    assert_eq!(status["index"]["chunkCount"], 2);
    assert_eq!(status["index"]["embeddingStats"]["embeddedChunks"], 2);
    assert_eq!(status["index"]["embeddingStats"]["reusedChunks"], 0);
    assert_eq!(status["index"]["embeddingStats"]["filesScanned"], 2);
    assert_eq!(status["index"]["embeddingStats"]["filesChanged"], 2);
    assert_eq!(status["index"]["embeddingStats"]["chunksAdded"], 2);
    assert_eq!(status["index"]["embeddingStats"]["vectorsWritten"], 2);
    assert_eq!(
        status["index"]["provider"]["modelId"],
        "test-gguf-embedding-2"
    );

    let search = project
        .search_semantic_index_json(
            json!({
                "indexId": "project",
                "query": "active company",
                "vector": [1.0, 0.0],
                "limit": 1
            })
            .to_string(),
        )
        .unwrap();
    let search: Value = serde_json::from_str(&search).unwrap();
    assert_eq!(search["results"][0]["chunk"]["path"], "src/company.ts");
    assert_eq!(search["results"][0]["scores"]["lexical"], 1.0);

    let lexical = project
        .search_semantic_index_json(
            json!({
                "indexId": "project",
                "query": "billing loader",
                "limit": 1
            })
            .to_string(),
        )
        .unwrap();
    let lexical: Value = serde_json::from_str(&lexical).unwrap();
    assert_eq!(lexical["results"][0]["chunk"]["path"], "src/company.ts");

    let filtered = project
        .search_semantic_index_json(
            json!({
                "indexId": "project",
                "vector": [1.0, 0.0],
                "paths": ["src/other.ts"],
                "limit": 1
            })
            .to_string(),
        )
        .unwrap();
    let filtered: Value = serde_json::from_str(&filtered).unwrap();
    assert_eq!(filtered["results"][0]["chunk"]["path"], "src/other.ts");

    let conn = Connection::open(root.join(".opencanon/state/test/state.sqlite")).unwrap();
    let chunk_count: i64 = conn
        .query_row("select count(*) from knowledge_chunks", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(chunk_count, 2);

    let reuse_request = json!({
        "index": {
            "id": "project",
            "version": "semantic-index-v3",
            "status": "ready",
            "provider": {
                "id": "opencanon-gguf-test",
                "kind": "gguf",
                "modelId": "test-gguf-embedding-2",
                "dimensions": 2,
                "distance": "cosine",
                "configHash": "config"
            },
            "chunkerVersion": "chunker",
            "producerVersion": "producer",
            "sourceInventoryHash": "inventory-reused",
            "chunkTreeHash": "chunk-tree-reused",
            "identityHash": "identity",
            "chunkCount": 2,
            "vectorCount": 2,
            "staleChunkCount": 0,
            "embeddingStats": {
                "totalChunks": 2,
                "embeddedChunks": 0,
                "reusedChunks": 2
            },
            "indexedAt": "2026-06-06T00:00:00.500Z",
            "diagnostics": []
        },
        "chunks": [
            {
                "metadata": {
                    "id": "chunk:one",
                    "path": "src/company.ts",
                    "contentHash": "content-one",
                    "chunkHash": "chunk-one",
                    "embeddingHash": "embedding-one",
                    "kind": "file",
                    "language": "typescript",
                    "ordinal": 0,
                    "range": {
                        "start": { "line": 1, "column": 1, "byte": 0 },
                        "end": { "line": 1, "column": 10, "byte": 10 }
                    },
                    "tokenCount": 2,
                    "preview": "active company"
                },
                "text": "active company billing loader",
                "vector": []
            },
            {
                "metadata": {
                    "id": "chunk:two",
                    "path": "src/other.ts",
                    "contentHash": "content-two",
                    "chunkHash": "chunk-two",
                    "embeddingHash": "embedding-two",
                    "kind": "file",
                    "language": "typescript",
                    "ordinal": 0,
                    "range": {
                        "start": { "line": 1, "column": 1, "byte": 0 },
                        "end": { "line": 1, "column": 10, "byte": 10 }
                    },
                    "tokenCount": 2,
                    "preview": "other record"
                },
                "text": "other record",
                "vector": []
            }
        ]
    });
    let reuse_error = project
        .write_semantic_index_json(reuse_request.to_string())
        .unwrap_err();
    assert!(reuse_error
        .to_string()
        .contains("Complete semantic index writes require a vector"));

    project
        .write_semantic_index_json(
            json!({
                "index": {
                    "id": "project",
                    "version": "semantic-index-v3",
                    "status": "ready",
                    "provider": {
                        "id": "opencanon-gguf-test",
                        "kind": "gguf",
                        "modelId": "test-gguf-embedding-2",
                        "dimensions": 2,
                        "distance": "cosine",
                        "configHash": "config"
                    },
                    "chunkerVersion": "chunker",
                    "producerVersion": "producer",
                    "sourceInventoryHash": "inventory-two",
                    "chunkTreeHash": "chunk-tree-two",
                    "identityHash": "identity",
                    "chunkCount": 1,
                    "vectorCount": 1,
                    "staleChunkCount": 0,
                    "indexedAt": "2026-06-06T00:00:01.000Z",
                    "diagnostics": []
                },
                "chunks": [
                    {
                        "metadata": {
                            "id": "chunk:two",
                            "path": "src/other.ts",
                            "contentHash": "content-two",
                            "chunkHash": "chunk-two",
                            "embeddingHash": "embedding-two",
                            "kind": "file",
                            "language": "typescript",
                            "ordinal": 0,
                            "range": {
                                "start": { "line": 1, "column": 1, "byte": 0 },
                                "end": { "line": 1, "column": 10, "byte": 10 }
                            },
                            "tokenCount": 2,
                            "preview": "other record"
                        },
                        "text": "other record",
                        "vector": [0.0, 1.0]
                    }
                ]
            })
            .to_string(),
        )
        .unwrap();

    let chunk_count: i64 = conn
        .query_row("select count(*) from knowledge_chunks", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(chunk_count, 1);

    let invalid = project.search_semantic_index_json(
        json!({
            "indexId": "project",
            "vector": [1.0, 0.0, 0.0],
            "limit": 1
        })
        .to_string(),
    );
    assert!(invalid
        .unwrap_err()
        .to_string()
        .contains("dimension mismatch"));
}

#[test]
fn knowledge_index_delta_updates_changed_paths_and_knowledge_nodes() {
    let root = test_root("semantic-index-delta");
    let project = open_test_project(&root);

    project
        .write_semantic_index_json(
            json!({
                "index": {
                    "id": "project",
                    "version": "semantic-index-v3",
                    "status": "ready",
                    "provider": {
                        "id": "opencanon-gguf-test",
                        "kind": "gguf",
                        "modelId": "test-gguf-embedding-2",
                        "dimensions": 2,
                        "distance": "cosine",
                        "configHash": "config"
                    },
                    "chunkerVersion": "chunker",
                    "producerVersion": "producer",
                    "sourceInventoryHash": "inventory",
                    "chunkTreeHash": "tree-one",
                    "identityHash": "identity",
                    "chunkCount": 2,
                    "vectorCount": 2,
                    "staleChunkCount": 0,
                    "embeddingStats": {
                        "totalChunks": 2,
                        "embeddedChunks": 2,
                        "reusedChunks": 0
                    },
                    "indexedAt": "2026-06-06T00:00:00.000Z",
                    "diagnostics": []
                },
                "nodes": [
                    { "key": ".", "kind": "root", "hash": "root-one", "parentKey": null, "children": ["src/company.ts", "src/other.ts"] },
                    { "key": "src/company.ts", "kind": "file", "hash": "company-file-one", "parentKey": ".", "children": ["src/company.ts#chunk:one"] },
                    { "key": "src/company.ts#chunk:one", "kind": "chunk", "hash": "chunk-one", "parentKey": "src/company.ts", "children": [] },
                    { "key": "src/other.ts", "kind": "file", "hash": "other-file-one", "parentKey": ".", "children": ["src/other.ts#chunk:two"] },
                    { "key": "src/other.ts#chunk:two", "kind": "chunk", "hash": "chunk-two", "parentKey": "src/other.ts", "children": [] }
                ],
                "chunks": [
                    {
                        "metadata": {
                            "id": "chunk:one",
                            "path": "src/company.ts",
                            "contentHash": "content-one",
                            "chunkHash": "chunk-one",
                            "embeddingHash": "embedding-one",
                            "kind": "file",
                            "language": "typescript",
                            "ordinal": 0,
                            "range": {
                                "start": { "line": 1, "column": 1, "byte": 0 },
                                "end": { "line": 1, "column": 10, "byte": 10 }
                            },
                            "tokenCount": 2,
                            "preview": "active company"
                        },
                        "text": "active company billing loader",
                        "vector": [1.0, 0.0]
                    },
                    {
                        "metadata": {
                            "id": "chunk:two",
                            "path": "src/other.ts",
                            "contentHash": "content-two",
                            "chunkHash": "chunk-two",
                            "embeddingHash": "embedding-two",
                            "kind": "file",
                            "language": "typescript",
                            "ordinal": 0,
                            "range": {
                                "start": { "line": 1, "column": 1, "byte": 0 },
                                "end": { "line": 1, "column": 10, "byte": 10 }
                            },
                            "tokenCount": 2,
                            "preview": "other record"
                        },
                        "text": "other record",
                        "vector": [0.0, 1.0]
                    }
                ]
            })
            .to_string(),
        )
        .unwrap();

    project
        .write_semantic_index_delta_json(
            json!({
                "index": {
                    "id": "project",
                    "version": "semantic-index-v3",
                    "status": "ready",
                    "provider": {
                        "id": "opencanon-gguf-test",
                        "kind": "gguf",
                        "modelId": "test-gguf-embedding-2",
                        "dimensions": 2,
                        "distance": "cosine",
                        "configHash": "config"
                    },
                    "chunkerVersion": "chunker",
                    "producerVersion": "producer",
                    "sourceInventoryHash": "inventory-two",
                    "chunkTreeHash": "tree-two",
                    "identityHash": "identity",
                    "chunkCount": 1,
                    "vectorCount": 1,
                    "staleChunkCount": 0,
                    "embeddingStats": {
                        "totalChunks": 1,
                        "embeddedChunks": 1,
                        "reusedChunks": 0,
                        "filesScanned": 1,
                        "filesChanged": 1,
                        "filesDeleted": 1,
                        "chunksAdded": 0,
                        "chunksChanged": 1,
                        "chunksRemoved": 1,
                        "vectorsWritten": 1,
                        "vectorsReused": 0
                    },
                    "indexedAt": "2026-06-06T00:00:01.000Z",
                    "diagnostics": []
                },
                "removedPaths": ["src/other.ts"],
                "nodes": [
                    { "key": ".", "kind": "root", "hash": "root-two", "parentKey": null, "children": ["src/company.ts"] },
                    { "key": "src/company.ts", "kind": "file", "hash": "company-file-two", "parentKey": ".", "children": ["src/company.ts#chunk:one"] },
                    { "key": "src/company.ts#chunk:one", "kind": "chunk", "hash": "chunk-one-updated", "parentKey": "src/company.ts", "children": [] }
                ],
                "chunks": [
                    {
                        "metadata": {
                            "id": "chunk:one",
                            "path": "src/company.ts",
                            "contentHash": "content-one-updated",
                            "chunkHash": "chunk-one-updated",
                            "embeddingHash": "embedding-one-updated",
                            "kind": "file",
                            "language": "typescript",
                            "ordinal": 0,
                            "range": {
                                "start": { "line": 1, "column": 1, "byte": 0 },
                                "end": { "line": 1, "column": 12, "byte": 12 }
                            },
                            "tokenCount": 3,
                            "preview": "active company updated"
                        },
                        "text": "active company billing loader updated",
                        "vector": [0.5, 0.5]
                    }
                ]
            })
            .to_string(),
        )
        .unwrap();

    let status = project
        .read_semantic_index_status_json(json!({ "indexId": "project" }).to_string())
        .unwrap();
    let status: Value = serde_json::from_str(&status).unwrap();
    assert_eq!(status["index"]["chunkCount"], 1);
    assert_eq!(status["index"]["chunkTreeHash"], "tree-two");
    assert_eq!(status["index"]["embeddingStats"]["filesDeleted"], 1);
    assert_eq!(status["index"]["embeddingStats"]["chunksChanged"], 1);
    assert_eq!(status["index"]["embeddingStats"]["chunksRemoved"], 1);
    assert_eq!(status["index"]["embeddingStats"]["vectorsWritten"], 1);

    let search = project
        .search_semantic_index_json(
            json!({
                "indexId": "project",
                "vector": [0.5, 0.5],
                "limit": 5
            })
            .to_string(),
        )
        .unwrap();
    let search: Value = serde_json::from_str(&search).unwrap();
    assert_eq!(search["results"][0]["chunk"]["path"], "src/company.ts");

    let conn = Connection::open(root.join(".opencanon/state/test/state.sqlite")).unwrap();
    let chunk_count: i64 = conn
        .query_row("select count(*) from knowledge_chunks", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(chunk_count, 1);
    let other_count: i64 = conn
        .query_row(
            "select count(*) from knowledge_chunks where path = 'src/other.ts'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(other_count, 0);
    let node_count: i64 = conn
        .query_row("select count(*) from knowledge_nodes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(node_count, 3);
    let other_node_count: i64 = conn
        .query_row(
            "select count(*) from knowledge_nodes where key = 'src/other.ts' or key like 'src/other.ts#%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(other_node_count, 0);

    let invalid_reuse = project.write_semantic_index_delta_json(
        json!({
            "index": {
                "id": "project",
                "version": "semantic-index-v3",
                "status": "ready",
                "provider": {
                    "id": "opencanon-gguf-test",
                    "kind": "gguf",
                    "modelId": "test-gguf-embedding-2",
                    "dimensions": 2,
                    "distance": "cosine",
                    "configHash": "config"
                },
                "chunkerVersion": "chunker",
                "producerVersion": "producer",
                "sourceInventoryHash": "inventory-three",
                "chunkTreeHash": "tree-three",
                "identityHash": "identity",
                "chunkCount": 1,
                "vectorCount": 1,
                "staleChunkCount": 0,
                "indexedAt": "2026-06-06T00:00:02.000Z",
                "diagnostics": []
            },
            "chunks": [{
                "metadata": {
                    "id": "chunk:one",
                    "path": "src/company.ts",
                    "contentHash": "content-one-updated",
                    "chunkHash": "chunk-one-updated-again",
                    "embeddingHash": "embedding-one-updated-again",
                    "kind": "file",
                    "language": "typescript",
                    "ordinal": 0,
                    "range": {
                        "start": { "line": 1, "column": 1, "byte": 0 },
                        "end": { "line": 1, "column": 12, "byte": 12 }
                    },
                    "tokenCount": 3,
                    "preview": "active company updated again"
                },
                "text": "active company billing loader updated again",
                "vector": []
            }]
        })
        .to_string(),
    );
    assert!(invalid_reuse
        .unwrap_err()
        .to_string()
        .contains("cannot reuse a missing or changed vector"));
}

#[test]
fn knowledge_index_delta_retains_unchanged_vectors_on_changed_paths() {
    let root = test_root("semantic-index-delta-reuse");
    let project = open_test_project(&root);
    project
        .write_semantic_index_json(complete_semantic_request().to_string())
        .unwrap();

    project
        .write_semantic_index_delta_json(
            json!({
                "index": {
                    "id": "project",
                    "version": "semantic-index-v3",
                    "status": "ready",
                    "provider": {
                        "id": "opencanon-gguf-test",
                        "kind": "gguf",
                        "modelId": "test-gguf-embedding-2",
                        "dimensions": 2,
                        "distance": "cosine",
                        "configHash": "config"
                    },
                    "chunkerVersion": "chunker",
                    "producerVersion": "producer",
                    "sourceInventoryHash": "inventory-two",
                    "chunkTreeHash": "tree-two",
                    "identityHash": "identity",
                    "chunkCount": 2,
                    "vectorCount": 2,
                    "staleChunkCount": 0,
                    "embeddingStats": {
                        "totalChunks": 2,
                        "embeddedChunks": 0,
                        "reusedChunks": 2,
                        "filesScanned": 2,
                        "filesChanged": 1,
                        "filesDeleted": 0,
                        "chunksAdded": 0,
                        "chunksChanged": 1,
                        "chunksRemoved": 1,
                        "vectorsWritten": 0,
                        "vectorsReused": 2
                    },
                    "indexedAt": "2026-06-06T00:00:01.000Z",
                    "diagnostics": []
                },
                "removedPaths": ["src/one.ts"],
                "removedNodeKeys": [],
                "nodes": [],
                "chunks": [{
                    "metadata": {
                        "id": "chunk:one",
                        "path": "src/one.ts",
                        "contentHash": "content-one-updated",
                        "chunkHash": "chunk-one-updated",
                        "embeddingHash": "embedding-one",
                        "kind": "file",
                        "language": "typescript",
                        "ordinal": 0,
                        "range": {
                            "start": { "line": 1, "column": 1, "byte": 0 },
                            "end": { "line": 1, "column": 12, "byte": 12 }
                        },
                        "tokenCount": 3,
                        "preview": "first chunk updated"
                    },
                    "text": "first chunk updated",
                    "vector": []
                }]
            })
            .to_string(),
        )
        .unwrap();

    let status: Value = serde_json::from_str(
        &project
            .read_semantic_index_status_json(json!({ "indexId": "project" }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(status["index"]["status"], "ready");
    assert_eq!(status["index"]["vectorCount"], 2);

    let search: Value = serde_json::from_str(
        &project
            .search_semantic_index_json(
                json!({ "indexId": "project", "vector": [1.0, 0.0], "limit": 2 }).to_string(),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(search["results"][0]["chunk"]["id"], "chunk:one");
}

#[test]
fn knowledge_index_recovers_when_vector_store_has_stale_duplicate_id() {
    let root = test_root("semantic-index-stale-vector-id");
    let project = open_test_project(&root);
    let request = json!({
        "index": {
            "id": "project",
            "version": "semantic-index-v3",
            "status": "ready",
            "provider": {
                "id": "opencanon-gguf-test",
                "kind": "gguf",
                "modelId": "test-gguf-embedding-2",
                "dimensions": 2,
                "distance": "cosine",
                "configHash": "config"
            },
            "chunkerVersion": "chunker",
            "producerVersion": "producer",
            "sourceInventoryHash": "inventory",
            "chunkTreeHash": "chunk-tree",
            "identityHash": "identity",
            "chunkCount": 1,
            "vectorCount": 1,
            "staleChunkCount": 0,
            "embeddingStats": {
                "totalChunks": 1,
                "embeddedChunks": 1,
                "reusedChunks": 0
            },
            "indexedAt": "2026-06-06T00:00:00.000Z",
            "diagnostics": []
        },
        "chunks": [
            {
                "metadata": {
                    "id": "chunk:stale",
                    "path": "src/company.ts",
                    "contentHash": "content-one",
                    "chunkHash": "chunk-one",
                    "embeddingHash": "embedding-one",
                    "kind": "file",
                    "language": "typescript",
                    "ordinal": 0,
                    "range": {
                        "start": { "line": 1, "column": 1, "byte": 0 },
                        "end": { "line": 1, "column": 10, "byte": 10 }
                    },
                    "tokenCount": 2,
                    "preview": "active company"
                },
                "text": "active company billing loader",
                "vector": [1.0, 0.0]
            }
        ]
    });

    project
        .write_semantic_index_json(request.to_string())
        .unwrap();

    let conn = Connection::open(root.join(".opencanon/state/test/state.sqlite")).unwrap();
    conn.execute("delete from knowledge_chunks where id = 'chunk:stale'", [])
        .unwrap();
    conn.execute(
        "delete from knowledge_chunks_fts where id = 'chunk:stale'",
        [],
    )
    .unwrap();

    project
        .write_semantic_index_json(request.to_string())
        .unwrap();

    let search = project
        .search_semantic_index_json(
            json!({
                "indexId": "project",
                "query": "active company",
                "vector": [1.0, 0.0],
                "limit": 1
            })
            .to_string(),
        )
        .unwrap();
    let search: Value = serde_json::from_str(&search).unwrap();
    assert_eq!(search["results"][0]["chunk"]["id"], "chunk:stale");
}

#[test]
fn knowledge_index_repair_clears_unsupported_provider_state() {
    let root = test_root("semantic-index-unsupported-provider");
    {
        let project = open_test_project(&root);
        project
            .write_semantic_index_json(
                json!({
                    "index": {
                        "id": "project",
                        "version": "semantic-index-v3",
                        "status": "ready",
                        "provider": {
                            "id": "unsupported-provider",
                            "kind": "unsupported",
                            "modelId": "test-unsupported-embedding-2",
                            "dimensions": 2,
                            "distance": "cosine",
                            "configHash": "config"
                        },
                        "chunkerVersion": "chunker",
                        "producerVersion": "producer",
                        "sourceInventoryHash": "inventory",
                        "chunkTreeHash": "chunk-tree",
                        "identityHash": "identity",
                        "chunkCount": 1,
                        "vectorCount": 1,
                        "staleChunkCount": 0,
                        "indexedAt": "2026-06-06T00:00:00.000Z",
                        "diagnostics": []
                    },
                    "chunks": [
                        {
                            "metadata": {
                                "id": "chunk:unsupported-provider",
                                "path": "src/company.ts",
                                "contentHash": "content",
                                "chunkHash": "chunk",
                                "embeddingHash": "embedding",
                                "kind": "file",
                                "language": "typescript",
                                "ordinal": 0,
                                "range": {
                                    "start": { "line": 1, "column": 1, "byte": 0 },
                                    "end": { "line": 1, "column": 10, "byte": 10 }
                                },
                                "tokenCount": 2,
                                "preview": "active company"
                            },
                            "text": "active company",
                            "vector": [1.0, 0.0]
                        }
                    ]
                })
                .to_string(),
            )
            .unwrap();
    }

    let project = open_test_project(&root);
    let status = project
        .read_semantic_index_status_json(json!({ "indexId": "project" }).to_string())
        .unwrap();
    let status: Value = serde_json::from_str(&status).unwrap();
    assert_eq!(status["index"], Value::Null);

    let conn = Connection::open(root.join(".opencanon/state/test/state.sqlite")).unwrap();
    let snapshot_count: i64 = conn
        .query_row("select count(*) from knowledge_snapshots", [], |row| {
            row.get(0)
        })
        .unwrap();
    let chunk_count: i64 = conn
        .query_row("select count(*) from knowledge_chunks", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(snapshot_count, 0);
    assert_eq!(chunk_count, 0);
}

#[test]
fn knowledge_index_rebuilds_obsolete_token_metadata_schema() {
    let root = test_root("semantic-index-obsolete-token-metadata");
    {
        let _project = open_test_project(&root);
    }
    let state_path = root.join(".opencanon/state/test/state.sqlite");
    {
        let conn = Connection::open(&state_path).unwrap();
        conn.execute_batch(
            "alter table knowledge_chunks rename column token_count to token_estimate;",
        )
        .unwrap();
    }

    let _reopened = open_test_project(&root);
    let conn = Connection::open(state_path).unwrap();
    let mut statement = conn.prepare("pragma table_info(knowledge_chunks)").unwrap();
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(columns.iter().any(|column| column == "token_count"));
    assert!(!columns.iter().any(|column| column == "token_estimate"));
}

#[test]
fn gguf_knowledge_survives_project_reopen() {
    let root = test_root("semantic-gguf-reopen");
    {
        let project = open_test_project(&root);
        project
            .write_semantic_index_json(complete_semantic_request().to_string())
            .unwrap();
    }

    let reopened = open_test_project(&root);
    let status: Value = serde_json::from_str(
        &reopened
            .read_semantic_index_status_json(json!({ "indexId": "project" }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(status["index"]["status"], "ready");
    assert_eq!(status["index"]["chunkCount"], 2);
}
