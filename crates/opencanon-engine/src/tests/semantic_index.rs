use rusqlite::Connection;
use serde_json::{json, Value};

use super::support::*;

#[test]
fn semantic_index_round_trips_metadata_and_searches_vectors() {
    let root = test_root("semantic-index");
    let project = open_test_project(&root);

    project
        .write_semantic_index_json(
            json!({
                "index": {
                    "id": "project",
                    "version": "semantic-index-v2",
                    "status": "ready",
                    "provider": {
                        "id": "opencanon-native-test",
                        "kind": "native",
                        "modelId": "test-native-embedding-2",
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
                        "reusedChunks": 0
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
                            "tokenEstimate": 2,
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
                            "tokenEstimate": 2,
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
    assert_eq!(
        status["index"]["provider"]["modelId"],
        "test-native-embedding-2"
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

    let conn = Connection::open(root.join(".opencanon/state.sqlite")).unwrap();
    let chunk_count: i64 = conn
        .query_row("select count(*) from semantic_chunks", [], |row| row.get(0))
        .unwrap();
    assert_eq!(chunk_count, 2);

    let reuse_request = json!({
        "index": {
            "id": "project",
            "version": "semantic-index-v2",
            "status": "ready",
            "provider": {
                "id": "opencanon-native-test",
                "kind": "native",
                "modelId": "test-native-embedding-2",
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
                    "tokenEstimate": 2,
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
                    "tokenEstimate": 2,
                    "preview": "other record"
                },
                "text": "other record",
                "vector": []
            }
        ]
    });
    project
        .write_semantic_index_json(reuse_request.to_string())
        .unwrap();
    let reused_search = project
        .search_semantic_index_json(
            json!({
                "indexId": "project",
                "vector": [1.0, 0.0],
                "limit": 1
            })
            .to_string(),
        )
        .unwrap();
    let reused_search: Value = serde_json::from_str(&reused_search).unwrap();
    assert_eq!(
        reused_search["results"][0]["chunk"]["path"],
        "src/company.ts"
    );
    let reused_status = project
        .read_semantic_index_status_json(json!({ "indexId": "project" }).to_string())
        .unwrap();
    let reused_status: Value = serde_json::from_str(&reused_status).unwrap();
    assert_eq!(
        reused_status["index"]["embeddingStats"]["embeddedChunks"],
        0
    );
    assert_eq!(reused_status["index"]["embeddingStats"]["reusedChunks"], 2);

    let mut invalid_reuse = reuse_request.clone();
    invalid_reuse["chunks"][0]["metadata"]["embeddingHash"] = json!("embedding-one-updated");
    invalid_reuse["index"]["sourceInventoryHash"] = json!("inventory-invalid");
    invalid_reuse["index"]["indexedAt"] = json!("2026-06-06T00:00:00.750Z");
    let invalid_error = project
        .write_semantic_index_json(invalid_reuse.to_string())
        .unwrap_err();
    assert!(invalid_error
        .to_string()
        .contains("cannot reuse a missing or changed vector"));

    project
        .write_semantic_index_json(
            json!({
                "index": {
                    "id": "project",
                    "version": "semantic-index-v2",
                    "status": "ready",
                    "provider": {
                        "id": "opencanon-native-test",
                        "kind": "native",
                        "modelId": "test-native-embedding-2",
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
                            "tokenEstimate": 2,
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
        .query_row("select count(*) from semantic_chunks", [], |row| row.get(0))
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
fn semantic_index_recovers_when_vector_store_has_stale_duplicate_id() {
    let root = test_root("semantic-index-stale-vector-id");
    let project = open_test_project(&root);
    let request = json!({
        "index": {
            "id": "project",
            "version": "semantic-index-v2",
            "status": "ready",
            "provider": {
                "id": "opencanon-native-test",
                "kind": "native",
                "modelId": "test-native-embedding-2",
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
                    "tokenEstimate": 2,
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

    let conn = Connection::open(root.join(".opencanon/state.sqlite")).unwrap();
    conn.execute("delete from semantic_chunks where id = 'chunk:stale'", [])
        .unwrap();
    conn.execute(
        "delete from semantic_chunks_fts where id = 'chunk:stale'",
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
fn semantic_index_repair_clears_unsupported_provider_state() {
    let root = test_root("semantic-index-unsupported-provider");
    {
        let project = open_test_project(&root);
        project
            .write_semantic_index_json(
                json!({
                    "index": {
                        "id": "project",
                        "version": "semantic-index-v2",
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
                                "tokenEstimate": 2,
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

    let conn = Connection::open(root.join(".opencanon/state.sqlite")).unwrap();
    let snapshot_count: i64 = conn
        .query_row("select count(*) from semantic_index_snapshots", [], |row| {
            row.get(0)
        })
        .unwrap();
    let chunk_count: i64 = conn
        .query_row("select count(*) from semantic_chunks", [], |row| row.get(0))
        .unwrap();
    assert_eq!(snapshot_count, 0);
    assert_eq!(chunk_count, 0);
}

#[test]
fn semantic_embedding_rejects_invalid_requests_before_loading_model() {
    let root = test_root("semantic-embedding-invalid");
    let project = open_test_project(&root);

    let missing_texts = project.embed_semantic_texts_json(
        json!({
            "modelId": "jina-code-v2",
            "task": "document",
            "texts": []
        })
        .to_string(),
    );
    assert!(missing_texts
        .unwrap_err()
        .to_string()
        .contains("at least one text"));

    let invalid_task = project.embed_semantic_texts_json(
        json!({
            "modelId": "jina-code-v2",
            "task": "other",
            "texts": ["company"]
        })
        .to_string(),
    );
    assert!(invalid_task
        .unwrap_err()
        .to_string()
        .contains("document or query"));
}

#[test]
fn generation_rejects_invalid_requests_before_loading_model() {
    let root = test_root("generation-invalid");
    let project = open_test_project(&root);

    let missing_prompt = project.generate_text_json(
        json!({
            "modelId": "qwen-coder-0.5b",
            "prompt": "",
            "showDownloadProgress": false
        })
        .to_string(),
    );
    assert!(missing_prompt
        .unwrap_err()
        .to_string()
        .contains("prompt is required"));

    let invalid_temperature = project.generate_text_json(
        json!({
            "modelId": "qwen-coder-0.5b",
            "prompt": "Plan the change.",
            "temperature": 3,
            "showDownloadProgress": false
        })
        .to_string(),
    );
    assert!(invalid_temperature
        .unwrap_err()
        .to_string()
        .contains("temperature"));
}
