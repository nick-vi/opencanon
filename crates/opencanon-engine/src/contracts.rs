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
    pub(crate) decisions_path: String,
    pub(crate) validators_path: String,
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
pub(crate) struct WatcherStatus {
    pub(crate) running: bool,
    pub(crate) buffered_events: usize,
    pub(crate) stale: bool,
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
pub(crate) struct ExportFact {
    pub(crate) line: usize,
    pub(crate) name: String,
    pub(crate) kind: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SymbolFact {
    pub(crate) line: usize,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) exported: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct CallFact {
    pub(crate) line: usize,
    pub(crate) name: String,
    pub(crate) callee: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiteralFact {
    pub(crate) line: usize,
    pub(crate) column: usize,
    pub(crate) value: String,
    pub(crate) value_kind: String,
    pub(crate) context: String,
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
