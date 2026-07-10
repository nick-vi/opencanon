use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenProjectRequest {
    pub(crate) root_dir: String,
    pub(crate) state_path: String,
    pub(crate) settings: ResolvedProjectSettings,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedProjectSettings {
    pub(crate) docs_dir: String,
    pub(crate) fixtures_dir: String,
    pub(crate) project_file_patterns: Vec<String>,
    pub(crate) ignore: Vec<String>,
    pub(crate) max_files: u32,
    pub(crate) max_file_size_kb: u32,
    pub(crate) file_discovery: String,
    pub(crate) config_hash: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ScanAndDiffRequest {
    pub(crate) files: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct WriteEventRequest {
    pub(crate) event: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ListEventsRequest {
    pub(crate) limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteObservabilityRecordsRequest {
    #[serde(default)]
    pub(crate) traces: Vec<serde_json::Value>,
    #[serde(default)]
    pub(crate) spans: Vec<serde_json::Value>,
    #[serde(default)]
    pub(crate) events: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListObservabilityRecordsRequest {
    pub(crate) limit: Option<u32>,
    pub(crate) trace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteSemanticIndexRequest {
    pub(crate) index: SemanticIndexSnapshotRequest,
    #[serde(default)]
    pub(crate) chunks: Vec<SemanticChunkEmbeddingRequest>,
    #[serde(default)]
    pub(crate) nodes: Vec<SemanticIndexNodeRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteSemanticIndexDeltaRequest {
    pub(crate) index: SemanticIndexSnapshotRequest,
    #[serde(default)]
    pub(crate) chunks: Vec<SemanticChunkEmbeddingRequest>,
    #[serde(default)]
    pub(crate) removed_paths: Vec<String>,
    #[serde(default)]
    pub(crate) removed_node_keys: Vec<String>,
    #[serde(default)]
    pub(crate) nodes: Vec<SemanticIndexNodeRequest>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticIndexSnapshotRequest {
    pub(crate) id: String,
    pub(crate) version: String,
    pub(crate) status: String,
    pub(crate) provider: SemanticEmbeddingProviderRequest,
    pub(crate) chunker_version: String,
    pub(crate) producer_version: String,
    pub(crate) source_inventory_hash: String,
    pub(crate) chunk_tree_hash: String,
    pub(crate) identity_hash: String,
    pub(crate) chunk_count: u32,
    pub(crate) vector_count: u32,
    pub(crate) stale_chunk_count: u32,
    pub(crate) embedding_stats: Option<SemanticIndexEmbeddingStatsRequest>,
    pub(crate) indexed_at: String,
    #[serde(default)]
    pub(crate) diagnostics: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticIndexEmbeddingStatsRequest {
    pub(crate) total_chunks: u32,
    pub(crate) embedded_chunks: u32,
    pub(crate) reused_chunks: u32,
    pub(crate) files_scanned: Option<u32>,
    pub(crate) files_changed: Option<u32>,
    pub(crate) files_deleted: Option<u32>,
    pub(crate) chunks_added: Option<u32>,
    pub(crate) chunks_changed: Option<u32>,
    pub(crate) chunks_removed: Option<u32>,
    pub(crate) vectors_written: Option<u32>,
    pub(crate) vectors_reused: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticIndexNodeRequest {
    pub(crate) key: String,
    pub(crate) kind: String,
    pub(crate) hash: String,
    pub(crate) parent_key: Option<String>,
    #[serde(default)]
    pub(crate) children: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticEmbeddingProviderRequest {
    pub(crate) id: String,
    #[serde(default = "default_semantic_provider_kind")]
    pub(crate) kind: String,
    pub(crate) display_name: Option<String>,
    pub(crate) model_id: String,
    pub(crate) model_digest: Option<String>,
    pub(crate) dimensions: u32,
    pub(crate) distance: String,
    pub(crate) config_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbedSemanticTextsRequest {
    pub(crate) model_id: String,
    #[serde(default = "default_semantic_embedding_task")]
    pub(crate) task: String,
    pub(crate) texts: Vec<String>,
    pub(crate) n_gpu_layers: Option<u32>,
    pub(crate) n_threads: Option<i32>,
    pub(crate) n_ctx: Option<u32>,
    #[serde(default = "default_show_download_progress")]
    pub(crate) show_download_progress: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerateTextRequest {
    pub(crate) model_id: String,
    pub(crate) prompt: String,
    pub(crate) max_tokens: Option<usize>,
    pub(crate) temperature: Option<f32>,
    pub(crate) top_p: Option<f32>,
    pub(crate) seed: Option<u32>,
    pub(crate) n_gpu_layers: Option<u32>,
    pub(crate) n_threads: Option<i32>,
    pub(crate) n_ctx: Option<u32>,
    #[serde(default = "default_show_download_progress")]
    pub(crate) show_download_progress: bool,
}

fn default_semantic_embedding_task() -> String {
    "document".to_string()
}

fn default_show_download_progress() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticChunkEmbeddingRequest {
    pub(crate) metadata: SemanticChunkMetadataRequest,
    pub(crate) text: String,
    pub(crate) vector: Vec<f32>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticChunkMetadataRequest {
    pub(crate) id: String,
    pub(crate) path: String,
    pub(crate) content_hash: String,
    pub(crate) chunk_hash: String,
    pub(crate) embedding_hash: String,
    pub(crate) kind: String,
    pub(crate) language: String,
    pub(crate) ordinal: u32,
    pub(crate) range: SymbolRange,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) heading: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) symbol: Option<String>,
    pub(crate) token_estimate: u32,
    pub(crate) preview: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SymbolRange {
    pub(crate) start: SymbolRangePosition,
    pub(crate) end: SymbolRangePosition,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SymbolRangePosition {
    pub(crate) line: u32,
    pub(crate) column: u32,
    pub(crate) byte: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadSemanticIndexStatusRequest {
    pub(crate) index_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchSemanticIndexRequest {
    pub(crate) index_id: Option<String>,
    pub(crate) query: Option<String>,
    pub(crate) vector: Option<Vec<f32>>,
    #[serde(default)]
    pub(crate) paths: Vec<String>,
    pub(crate) limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListSemanticChunksRequest {
    pub(crate) index_id: Option<String>,
    #[serde(default)]
    pub(crate) paths: Vec<String>,
    pub(crate) limit: Option<u32>,
    pub(crate) offset: Option<u32>,
}

fn default_semantic_provider_kind() -> String {
    "local".to_string()
}

#[derive(Debug, Deserialize)]
pub(crate) struct WriteProductModelProjectionRequest {
    pub(crate) projection: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartWatcherRequest {
    pub(crate) debounce_ms: Option<u64>,
    pub(crate) buffer_capacity: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatcherStartResult {
    pub(crate) running: bool,
    pub(crate) debounce_ms: u64,
    pub(crate) buffer_capacity: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatcherEventBatch {
    pub(crate) root_dir: String,
    pub(crate) paths: Vec<String>,
    pub(crate) stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
    pub(crate) timestamp: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRefreshStatus {
    pub(crate) status: String,
    pub(crate) mode: String,
    pub(crate) buffered_events: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractFactsRequest {
    pub(crate) files: Vec<FactFileRequest>,
    pub(crate) facts: Vec<String>,
    pub(crate) parser_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FactFileRequest {
    pub(crate) path: String,
    pub(crate) content_hash: String,
    pub(crate) language: String,
    #[serde(default)]
    pub(crate) content: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuildRepoGraphRequest {
    pub(crate) facts: Vec<FileFacts>,
    #[serde(default)]
    pub(crate) package_manifests: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileFacts {
    pub(crate) path: String,
    pub(crate) content_hash: String,
    pub(crate) language: String,
    pub(crate) parser: String,
    pub(crate) parser_version: String,
    #[serde(default)]
    pub(crate) imports: Vec<ImportFact>,
    #[serde(default)]
    pub(crate) exports: Vec<ExportFact>,
    #[serde(default)]
    pub(crate) symbols: Vec<SymbolFact>,
    #[serde(default)]
    pub(crate) declarations: Vec<DeclarationFact>,
    #[serde(default)]
    pub(crate) calls: Vec<CallFact>,
    #[serde(default)]
    pub(crate) literals: Vec<LiteralFact>,
    #[serde(default)]
    pub(crate) comments: Vec<CommentFact>,
    #[serde(default)]
    pub(crate) diagnostics: Vec<FactDiagnostic>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportFact {
    pub(crate) line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) column: Option<usize>,
    pub(crate) source: String,
    pub(crate) specifiers: Vec<String>,
    pub(crate) kind: String,
    pub(crate) resolution: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportFact {
    pub(crate) line: usize,
    pub(crate) name: String,
    pub(crate) kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) imported_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) type_only: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SymbolFact {
    pub(crate) line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) end_line: Option<usize>,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) exported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) params: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeclarationFact {
    pub(crate) line: usize,
    pub(crate) end_line: usize,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) exported: bool,
    pub(crate) text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) const_enum: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) members: Vec<EnumMemberFact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) declaration_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) initializer: Option<InitializerFact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) r#async: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnumMemberFact {
    pub(crate) line: usize,
    pub(crate) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) value: Option<String>,
    pub(crate) value_kind: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObjectPropertyFact {
    pub(crate) line: usize,
    pub(crate) key: String,
    pub(crate) quoted: bool,
    pub(crate) value: String,
    pub(crate) value_kind: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InitializerFact {
    pub(crate) kind: String,
    pub(crate) as_const: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) satisfies: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) properties: Vec<ObjectPropertyFact>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CallFact {
    pub(crate) line: usize,
    pub(crate) column: usize,
    pub(crate) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) receiver: Option<String>,
    pub(crate) callee: String,
    pub(crate) try_depth: usize,
    pub(crate) argument_calls: Vec<CallArgumentFact>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CallArgumentFact {
    pub(crate) callee: String,
    pub(crate) name: String,
    pub(crate) awaited: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiteralFact {
    pub(crate) line: usize,
    pub(crate) column: usize,
    pub(crate) value: String,
    pub(crate) value_kind: String,
    pub(crate) context: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) declaration_source_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct CommentFact {
    pub(crate) line: usize,
    pub(crate) column: usize,
    pub(crate) text: String,
    pub(crate) kind: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct FactDiagnostic {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) severity: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndexCodeGraphRequest {
    pub(crate) files: Vec<IndexCodeGraphFile>,
    #[serde(default)]
    pub(crate) deleted_files: Vec<String>,
    #[serde(default)]
    pub(crate) parser_version: String,
    #[serde(default)]
    pub(crate) extractor_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndexCodeGraphFile {
    pub(crate) path: String,
    pub(crate) content_hash: String,
    pub(crate) language: String,
    #[serde(default)]
    pub(crate) content: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchSymbolsRequest {
    #[serde(default)]
    pub(crate) query: Option<String>,
    #[serde(default)]
    pub(crate) path: Option<String>,
    #[serde(default)]
    pub(crate) kind: Option<String>,
    #[serde(default)]
    pub(crate) limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchReferencesRequest {
    #[serde(default)]
    pub(crate) query: Option<String>,
    #[serde(default)]
    pub(crate) path: Option<String>,
    #[serde(default)]
    pub(crate) source: Option<String>,
    #[serde(default)]
    pub(crate) kind: Option<String>,
    #[serde(default)]
    pub(crate) limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchGraphEdgesRequest {
    #[serde(default)]
    pub(crate) query: Option<String>,
    #[serde(default)]
    pub(crate) symbol_id: Option<String>,
    #[serde(default)]
    pub(crate) path: Option<String>,
    #[serde(default)]
    pub(crate) kind: Option<String>,
    #[serde(default)]
    pub(crate) direction: Option<String>,
    #[serde(default)]
    pub(crate) limit: Option<u32>,
}
