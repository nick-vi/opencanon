use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicBool, mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use napi_derive::napi;
use notify::{Event, RecursiveMode, Watcher};
use opencanon_inference::{
    Embedder, EmbedderConfig, GenerateOptions, Generator, GeneratorConfig, InferenceError,
};
use opencanon_vector::{Config as VectorConfig, EmbedDbError, EmbeddingDb};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::code_graph::{
    compute_edge_id, compute_node_id, compute_unresolved_id, language_is_supported,
    CodeExtractionInput, CodeExtractor, ExtractedNode, ExtractedUnresolved, OxcExtractor,
    PythonExtractor,
};
use crate::constants::{
    EXTRACTOR_VERSION, PARSER_VERSION, WATCHER_DEFAULT_BUFFER_CAPACITY,
    WATCHER_DEFAULT_DEBOUNCE_MS, WATCHER_MAX_BUFFER_CAPACITY, WATCHER_MAX_DEBOUNCE_MS,
    WATCHER_MIN_DEBOUNCE_MS,
};
use crate::contracts::{
    BuildRepoGraphRequest, EmbedSemanticTextsRequest, ExtractFactsRequest, FactDiagnostic,
    GenerateTextRequest, IndexCodeGraphRequest, ListEventsRequest, ListObservabilityRecordsRequest,
    ListSemanticChunksRequest, OpenProjectRequest, ProjectRefreshStatus,
    ReadSemanticIndexStatusRequest, ResolvedProjectSettings, ScanAndDiffRequest,
    SearchGraphEdgesRequest, SearchReferencesRequest, SearchSemanticIndexRequest,
    SearchSymbolsRequest, SemanticChunkEmbeddingRequest, StartWatcherRequest, WatcherStartResult,
    WriteEventRequest, WriteObservabilityRecordsRequest, WriteProductModelProjectionRequest,
    WriteSemanticIndexRequest,
};
use crate::facts::{package_nodes, scan_file_facts};
use crate::json::{decode, encode, napi_error, notify_error, sqlite_error};
use crate::observability::{ObservationBatch, ObservationSink};
use crate::state::{
    migrate_state, read_existing_file_hashes, read_watch_state_status, schema_version, timestamp,
};
use crate::watcher::{
    build_watcher_filter, run_watcher_thread, NativeWatcher, WatcherCallback, WatcherQueue,
    WatcherThreadInput,
};

#[napi]
pub struct EngineProjectHandle {
    root_dir: String,
    state_path: String,
    settings: ResolvedProjectSettings,
    migrations_applied: Vec<u32>,
    conn: Mutex<Connection>,
    watcher_queue: WatcherQueue,
    watcher: Mutex<Option<NativeWatcher>>,
    embedding_cache: Mutex<HashMap<String, Embedder>>,
    generation_cache: Mutex<HashMap<String, Generator>>,
}

#[napi]
impl EngineProjectHandle {
    #[napi(js_name = "statusJson")]
    pub fn status_json(&self) -> napi::Result<String> {
        let refresh = self.project_refresh_status()?;
        encode(&json!({
          "rootDir": self.root_dir,
          "statePath": self.state_path,
          "schemaVersion": schema_version(),
          "migrationsApplied": self.migrations_applied,
          "refresh": refresh,
        }))
    }

    #[napi(js_name = "scanAndDiffJson")]
    pub fn scan_and_diff_json(&self, request: String) -> napi::Result<String> {
        let request: ScanAndDiffRequest = decode(&request)?;
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        let tx = conn
            .transaction()
            .map_err(|error| sqlite_error("Could not start scan transaction", error))?;
        let mut existing = read_existing_file_hashes(&tx)?;
        let mut files = Vec::new();
        let mut changed_files = Vec::new();
        let mut unchanged_files = Vec::new();
        let mut inventory_parts = Vec::new();
        let indexed_at = timestamp();

        for file in request.files.iter() {
            let absolute = root_path(&self.root_dir, file);
            let bytes = fs::read(&absolute).map_err(|error| {
                napi_error(
                    "invalid-engine-payload",
                    &format!("Could not read {file}: {error}"),
                )
            })?;
            let content_hash = blake3::hash(&bytes).to_hex().to_string();
            let size = bytes.len() as i64;
            match existing.remove(file) {
                Some(previous_hash) if previous_hash == content_hash => {
                    unchanged_files.push(file.clone());
                }
                _ => {
                    changed_files.push(file.clone());
                }
            }
            tx.execute(
                "insert into files(path, content_hash, size, indexed_at, stale) values (?1, ?2, ?3, ?4, 0)
                 on conflict(path) do update set content_hash = excluded.content_hash, size = excluded.size, indexed_at = excluded.indexed_at, stale = 0",
                params![file, content_hash, size, indexed_at],
            )
            .map_err(|error| sqlite_error("Could not upsert file state", error))?;
            inventory_parts.push(format!("{file}\0{content_hash}"));
            files.push(json!({
              "path": file,
              "contentHash": content_hash,
              "size": size,
              "stale": false,
            }));
        }

        let mut deleted_files = existing.keys().cloned().collect::<Vec<_>>();
        deleted_files.sort();
        for file in deleted_files.iter() {
            tx.execute("delete from files where path = ?1", params![file])
                .map_err(|error| sqlite_error("Could not delete file state", error))?;
            tx.execute("delete from facts where path = ?1", params![file])
                .map_err(|error| sqlite_error("Could not delete fact state", error))?;
        }

        inventory_parts.sort();
        let inventory_hash = blake3::hash(inventory_parts.join("\n").as_bytes())
            .to_hex()
            .to_string();
        tx.execute(
            "insert into watch_state(root_dir, inventory_hash, stale, reason, updated_at) values (?1, ?2, 0, null, ?3)
             on conflict(root_dir) do update set inventory_hash = excluded.inventory_hash, stale = 0, reason = null, updated_at = excluded.updated_at",
            params![self.root_dir, inventory_hash, indexed_at],
        )
        .map_err(|error| sqlite_error("Could not update watch state", error))?;
        tx.commit()
            .map_err(|error| sqlite_error("Could not commit scan transaction", error))?;

        changed_files.sort();
        unchanged_files.sort();

        encode(&json!({
          "statePath": self.state_path,
          "schemaVersion": schema_version(),
          "inventoryHash": inventory_hash,
          "files": files,
          "changedFiles": changed_files,
          "unchangedFiles": unchanged_files,
          "deletedFiles": deleted_files,
          "staleFiles": 0,
        }))
    }

    #[napi(js_name = "extractFactsJson")]
    pub fn extract_facts_json(&self, request: String) -> napi::Result<String> {
        let request: ExtractFactsRequest = decode(&request)?;
        let requested: HashSet<String> = request.facts.into_iter().collect();
        let parser_version = if request.parser_version.trim().is_empty() {
            PARSER_VERSION.to_string()
        } else {
            request.parser_version
        };

        let mut files = Vec::new();
        let mut diagnostics = Vec::new();

        for file in request.files {
            let text = match file.content.as_deref() {
                Some(content) => content.to_string(),
                None => match fs::read_to_string(root_path(&self.root_dir, &file.path)) {
                    Ok(text) => text,
                    Err(error) => {
                        diagnostics.push(FactDiagnostic {
                            code: "read-failed".to_string(),
                            message: format!("Could not read {}: {error}", file.path),
                            severity: "error".to_string(),
                        });
                        continue;
                    }
                },
            };

            files.push(scan_file_facts(&file, &text, &requested, &parser_version));
        }

        encode(&json!({ "files": files, "diagnostics": diagnostics }))
    }

    #[napi(js_name = "buildRepoGraphJson")]
    pub fn build_repo_graph_json(&self, request: String) -> napi::Result<String> {
        let request: BuildRepoGraphRequest = decode(&request)?;
        let files = request
            .facts
            .iter()
            .map(|fact| fact.path.clone())
            .collect::<Vec<_>>();
        let import_edges = request
            .facts
            .iter()
            .flat_map(|fact| {
                fact.imports.iter().map(|import| {
                    json!({
                      "from": fact.path,
                      "source": import.source,
                      "resolution": import.resolution,
                    })
                })
            })
            .collect::<Vec<_>>();
        let graph_hash = blake3::hash(
            serde_json::to_string(&request.facts)
                .unwrap_or_default()
                .as_bytes(),
        )
        .to_hex()
        .to_string();

        encode(&json!({
          "graph": {
            "rootDir": self.root_dir.as_str(),
            "graphHash": graph_hash,
            "files": files,
            "packages": package_nodes(&request.package_manifests),
            "importEdges": import_edges,
          }
        }))
    }

    #[napi(js_name = "indexCodeGraphJson")]
    pub fn index_code_graph_json(&self, request: String) -> napi::Result<String> {
        let request: IndexCodeGraphRequest = decode(&request)?;
        let parser_version = if request.parser_version.trim().is_empty() {
            PARSER_VERSION.to_string()
        } else {
            request.parser_version
        };
        let extractor_version = if request.extractor_version.trim().is_empty() {
            EXTRACTOR_VERSION.to_string()
        } else {
            request.extractor_version
        };
        let indexed_at = timestamp();
        let oxc_extractor = OxcExtractor;
        let python_extractor = PythonExtractor;

        let mut prepared = Vec::with_capacity(request.files.len());
        let mut diagnostics = Vec::new();
        for file in request.files.iter() {
            // Prefer caller-supplied content (the exact scanned bytes — no
            // scan->index disk-reread TOCTOU); read disk only when absent.
            let text = match file.content.as_deref() {
                Some(content) => content.to_string(),
                None => match fs::read_to_string(root_path(&self.root_dir, &file.path)) {
                    Ok(text) => text,
                    Err(error) => {
                        diagnostics.push(json!({
                          "path": file.path,
                          "code": "read-failed",
                          "message": format!("Could not read {}: {error}", file.path),
                          "severity": "error",
                        }));
                        continue;
                    }
                },
            };
            let input = CodeExtractionInput {
                path: &file.path,
                language: &file.language,
                text: &text,
                content_hash: &file.content_hash,
                extractor_version: &extractor_version,
            };
            let result = if !language_is_supported(&file.language) {
                oxc_extractor.extract(input)
            } else {
                match file.language.as_str() {
                    "python" => python_extractor.extract(input),
                    _ => oxc_extractor.extract(input),
                }
            };
            prepared.push((file, result));
        }

        let mut conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        let tx = conn
            .transaction()
            .map_err(|error| sqlite_error("Could not start graph index transaction", error))?;

        for path in request.deleted_files.iter() {
            tx.execute("delete from code_edges where path = ?1", params![path])
                .map_err(|error| sqlite_error("Could not delete code edges", error))?;
            tx.execute("delete from code_nodes where path = ?1", params![path])
                .map_err(|error| sqlite_error("Could not delete code nodes", error))?;
            tx.execute(
                "delete from unresolved_references where path = ?1",
                params![path],
            )
            .map_err(|error| sqlite_error("Could not delete unresolved references", error))?;
            tx.execute(
                "delete from code_extractions where path = ?1",
                params![path],
            )
            .map_err(|error| sqlite_error("Could not delete code extraction", error))?;
        }

        let mut indexed = Vec::new();
        for (file, result) in prepared.iter() {
            tx.execute("delete from code_edges where path = ?1", params![file.path])
                .map_err(|error| sqlite_error("Could not clear prior code edges", error))?;
            tx.execute("delete from code_nodes where path = ?1", params![file.path])
                .map_err(|error| sqlite_error("Could not clear prior code nodes", error))?;
            tx.execute(
                "delete from unresolved_references where path = ?1",
                params![file.path],
            )
            .map_err(|error| sqlite_error("Could not clear prior unresolved references", error))?;

            for node in result.nodes.iter() {
                insert_code_node(
                    &tx,
                    &file.path,
                    &file.language,
                    &file.content_hash,
                    &extractor_version,
                    &indexed_at,
                    node,
                )?;
            }
            for unresolved in result.unresolved.iter() {
                insert_unresolved_reference(
                    &tx,
                    &file.path,
                    &file.language,
                    &file.content_hash,
                    &extractor_version,
                    &indexed_at,
                    unresolved,
                )?;
            }

            let diagnostics_json = serde_json::to_string(&result.diagnostics)
                .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
            tx.execute(
                "insert into code_extractions(path, content_hash, parser_version, extractor_version, extracted_at, diagnostics)
                 values (?1, ?2, ?3, ?4, ?5, ?6)
                 on conflict(path) do update set content_hash = excluded.content_hash, parser_version = excluded.parser_version,
                 extractor_version = excluded.extractor_version, extracted_at = excluded.extracted_at, diagnostics = excluded.diagnostics",
                params![file.path, file.content_hash, parser_version, extractor_version, indexed_at, diagnostics_json],
            )
            .map_err(|error| sqlite_error("Could not record code extraction", error))?;

            indexed.push(json!({
              "path": file.path,
              "nodes": result.nodes.len(),
              "unresolved": result.unresolved.len(),
              "supported": result.supported,
            }));
            for diagnostic in result.diagnostics.iter() {
                diagnostics.push(json!({
                  "path": file.path,
                  "code": diagnostic.code,
                  "message": diagnostic.message,
                  "severity": diagnostic.severity,
                }));
            }
        }
        tx.execute("delete from code_edges", [])
            .map_err(|error| sqlite_error("Could not clear resolved code edges", error))?;
        resolve_exact_code_edges(&tx, &self.root_dir)?;

        tx.commit()
            .map_err(|error| sqlite_error("Could not commit graph index transaction", error))?;

        encode(&json!({
          "indexed": indexed,
          "deleted": request.deleted_files,
          "diagnostics": diagnostics,
          "parserVersion": parser_version,
          "extractorVersion": extractor_version,
        }))
    }

    #[napi(js_name = "searchSymbolsJson")]
    pub fn search_symbols_json(&self, request: String) -> napi::Result<String> {
        let request: SearchSymbolsRequest = decode(&request)?;
        let limit = request.limit.unwrap_or(50).clamp(1, 500) as i64;
        let conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;

        let trimmed_query = request
            .query
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(fts_match_query)
            .filter(|value| !value.is_empty());

        let mut sql = String::new();
        let mut bind: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(query) = trimmed_query {
            sql.push_str(
                "select n.id, n.path, n.language, n.kind, n.name, n.qualified_name, n.exported, n.signature,\n                       n.start_line, n.start_column, n.start_byte, n.end_line, n.end_column, n.end_byte,\n                       fts.rank as score\n                from code_node_search_fts fts\n                join code_nodes n on n.rowid = fts.rowid\n                where code_node_search_fts MATCH ?1",
            );
            bind.push(query.into());
            let mut next = 2;
            if let Some(path) = request.path.as_deref() {
                sql.push_str(&format!(" and n.path = ?{next}"));
                bind.push(path.to_string().into());
                next += 1;
            }
            if let Some(kind) = request.kind.as_deref() {
                sql.push_str(&format!(" and n.kind = ?{next}"));
                bind.push(kind.to_string().into());
                next += 1;
            }
            sql.push_str(&format!(
                " order by score, n.path, n.start_line limit ?{next}"
            ));
            bind.push(limit.into());
        } else {
            sql.push_str(
                "select n.id, n.path, n.language, n.kind, n.name, n.qualified_name, n.exported, n.signature,\n                       n.start_line, n.start_column, n.start_byte, n.end_line, n.end_column, n.end_byte,\n                       null as score\n                from code_nodes n where 1 = 1",
            );
            let mut next = 1;
            if let Some(path) = request.path.as_deref() {
                sql.push_str(&format!(" and n.path = ?{next}"));
                bind.push(path.to_string().into());
                next += 1;
            }
            if let Some(kind) = request.kind.as_deref() {
                sql.push_str(&format!(" and n.kind = ?{next}"));
                bind.push(kind.to_string().into());
                next += 1;
            }
            sql.push_str(&format!(" order by n.path, n.start_line limit ?{next}"));
            bind.push(limit.into());
        }

        let mut statement = conn
            .prepare(&sql)
            .map_err(|error| sqlite_error("Could not prepare symbol search", error))?;
        let params = rusqlite::params_from_iter(bind);
        let rows = statement
            .query_map(params, |row| {
                Ok(json!({
                  "id": row.get::<_, String>(0)?,
                  "path": row.get::<_, String>(1)?,
                  "language": row.get::<_, String>(2)?,
                  "kind": row.get::<_, String>(3)?,
                  "name": row.get::<_, String>(4)?,
                  "qualifiedName": row.get::<_, String>(5)?,
                  "exported": row.get::<_, i64>(6)? != 0,
                  "signature": row.get::<_, Option<String>>(7)?,
                  "range": {
                    "start": {
                      "line": row.get::<_, i64>(8)?,
                      "column": row.get::<_, i64>(9)?,
                      "byte": row.get::<_, i64>(10)?,
                    },
                    "end": {
                      "line": row.get::<_, i64>(11)?,
                      "column": row.get::<_, i64>(12)?,
                      "byte": row.get::<_, i64>(13)?,
                    },
                  },
                  "score": row.get::<_, Option<f64>>(14)?,
                }))
            })
            .map_err(|error| sqlite_error("Could not run symbol search", error))?;

        let mut symbols = Vec::new();
        for row in rows {
            symbols.push(row.map_err(|error| sqlite_error("Could not decode symbol row", error))?);
        }
        encode(&json!({ "symbols": symbols }))
    }

    #[napi(js_name = "searchReferencesJson")]
    pub fn search_references_json(&self, request: String) -> napi::Result<String> {
        let request: SearchReferencesRequest = decode(&request)?;
        let limit = request.limit.unwrap_or(100).clamp(1, 1000) as i64;
        let conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;

        let mut sql = String::from(
            "select id, path, language, reference_name, reference_kind, source,
                    start_line, start_column, start_byte, end_line, end_column, end_byte,
                    provenance, confidence
             from unresolved_references where 1 = 1",
        );
        let mut bind: Vec<rusqlite::types::Value> = Vec::new();
        let mut next = 1;
        if let Some(query) = request
            .query
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            sql.push_str(&format!(" and reference_name = ?{next}"));
            bind.push(query.to_string().into());
            next += 1;
        }
        if let Some(path) = request.path.as_deref() {
            sql.push_str(&format!(" and path = ?{next}"));
            bind.push(path.to_string().into());
            next += 1;
        }
        if let Some(source) = request.source.as_deref() {
            sql.push_str(&format!(" and source = ?{next}"));
            bind.push(source.to_string().into());
            next += 1;
        }
        if let Some(kind) = request.kind.as_deref() {
            sql.push_str(&format!(" and reference_kind = ?{next}"));
            bind.push(kind.to_string().into());
            next += 1;
        }
        sql.push_str(&format!(
            " order by path, start_line, start_column limit ?{next}"
        ));
        bind.push(limit.into());

        let mut statement = conn
            .prepare(&sql)
            .map_err(|error| sqlite_error("Could not prepare reference search", error))?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(bind), |row| {
                Ok(json!({
                  "id": row.get::<_, String>(0)?,
                  "path": row.get::<_, String>(1)?,
                  "language": row.get::<_, String>(2)?,
                  "name": row.get::<_, String>(3)?,
                  "kind": row.get::<_, String>(4)?,
                  "source": row.get::<_, Option<String>>(5)?,
                  "range": {
                    "start": {
                      "line": row.get::<_, i64>(6)?,
                      "column": row.get::<_, i64>(7)?,
                      "byte": row.get::<_, i64>(8)?,
                    },
                    "end": {
                      "line": row.get::<_, i64>(9)?,
                      "column": row.get::<_, i64>(10)?,
                      "byte": row.get::<_, i64>(11)?,
                    },
                  },
                  "provenance": row.get::<_, String>(12)?,
                  "confidence": row.get::<_, String>(13)?,
                }))
            })
            .map_err(|error| sqlite_error("Could not run reference search", error))?;

        let mut references = Vec::new();
        for row in rows {
            references
                .push(row.map_err(|error| sqlite_error("Could not decode reference row", error))?);
        }
        encode(&json!({ "references": references }))
    }

    #[napi(js_name = "searchGraphEdgesJson")]
    pub fn search_graph_edges_json(&self, request: String) -> napi::Result<String> {
        let request: SearchGraphEdgesRequest = decode(&request)?;
        let limit = request.limit.unwrap_or(100).clamp(1, 1000) as i64;
        let direction = request.direction.as_deref().unwrap_or("both");
        if !matches!(direction, "incoming" | "outgoing" | "both") {
            return Err(napi_error(
                "invalid-engine-payload",
                "Graph edge direction must be incoming, outgoing, or both.",
            ));
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;

        let mut sql = String::from(
            "select e.id, e.kind, e.provenance, e.confidence, e.path, e.start_line, e.start_column, e.start_byte,
                    source.id, source.path, source.language, source.kind, source.name, source.qualified_name,
                    source.exported, source.signature, source.start_line, source.start_column, source.start_byte,
                    source.end_line, source.end_column, source.end_byte,
                    target.id, target.path, target.language, target.kind, target.name, target.qualified_name,
                    target.exported, target.signature, target.start_line, target.start_column, target.start_byte,
                    target.end_line, target.end_column, target.end_byte
             from code_edges e
             join code_nodes source on source.id = e.source_id
             join code_nodes target on target.id = e.target_id
             where 1 = 1",
        );
        let mut bind: Vec<rusqlite::types::Value> = Vec::new();
        let mut next = 1;
        if let Some(kind) = request.kind.as_deref() {
            sql.push_str(&format!(" and e.kind = ?{next}"));
            bind.push(kind.to_string().into());
            next += 1;
        }
        if let Some(path) = request.path.as_deref() {
            sql.push_str(&format!(" and e.path = ?{next}"));
            bind.push(path.to_string().into());
            next += 1;
        }
        if let Some(symbol_id) = request.symbol_id.as_deref() {
            match direction {
                "incoming" => sql.push_str(&format!(" and e.target_id = ?{next}")),
                "outgoing" => sql.push_str(&format!(" and e.source_id = ?{next}")),
                _ => sql.push_str(&format!(
                    " and (e.source_id = ?{next} or e.target_id = ?{next})"
                )),
            }
            bind.push(symbol_id.to_string().into());
            next += 1;
        }
        if let Some(query) = request
            .query
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            match direction {
                "incoming" => sql.push_str(&format!(" and target.name = ?{next}")),
                "outgoing" => sql.push_str(&format!(" and source.name = ?{next}")),
                _ => sql.push_str(&format!(
                    " and (source.name = ?{next} or target.name = ?{next})"
                )),
            }
            bind.push(query.to_string().into());
            next += 1;
        }
        sql.push_str(&format!(
            " order by e.path, e.start_line, e.start_column limit ?{next}"
        ));
        bind.push(limit.into());

        let mut statement = conn
            .prepare(&sql)
            .map_err(|error| sqlite_error("Could not prepare graph edge search", error))?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(bind), |row| {
                Ok(json!({
                  "id": row.get::<_, String>(0)?,
                  "kind": row.get::<_, String>(1)?,
                  "provenance": row.get::<_, String>(2)?,
                  "confidence": row.get::<_, String>(3)?,
                  "path": row.get::<_, String>(4)?,
                  "range": {
                    "start": {
                      "line": row.get::<_, Option<i64>>(5)?.unwrap_or(1),
                      "column": row.get::<_, Option<i64>>(6)?.unwrap_or(1),
                      "byte": row.get::<_, Option<i64>>(7)?.unwrap_or(0),
                    }
                  },
                  "source": code_symbol_json(row, 8)?,
                  "target": code_symbol_json(row, 22)?,
                }))
            })
            .map_err(|error| sqlite_error("Could not run graph edge search", error))?;

        let mut edges = Vec::new();
        for row in rows {
            edges
                .push(row.map_err(|error| sqlite_error("Could not decode graph edge row", error))?);
        }
        encode(&json!({ "edges": edges }))
    }

    #[napi]
    pub fn close(&self) {
        self.stop_watcher();
    }

    #[napi(js_name = "startWatcherJson")]
    pub fn start_watcher_json(
        &self,
        request: String,
        callback: WatcherCallback,
    ) -> napi::Result<String> {
        let request: StartWatcherRequest = decode(&request)?;
        let debounce_ms = request
            .debounce_ms
            .unwrap_or(WATCHER_DEFAULT_DEBOUNCE_MS)
            .clamp(WATCHER_MIN_DEBOUNCE_MS, WATCHER_MAX_DEBOUNCE_MS);
        let buffer_capacity = request
            .buffer_capacity
            .unwrap_or(WATCHER_DEFAULT_BUFFER_CAPACITY)
            .clamp(1, WATCHER_MAX_BUFFER_CAPACITY);
        let filter = build_watcher_filter(&self.settings)?;
        let root_dir = PathBuf::from(&self.root_dir);
        let state_path = self.state_path.clone();
        let queue = self.watcher_queue.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = stop.clone();
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = notify::recommended_watcher(tx)
            .map_err(|error| notify_error("Could not create engine watcher", error))?;
        watcher
            .watch(&root_dir, RecursiveMode::Recursive)
            .map_err(|error| notify_error("Could not watch project root", error))?;
        let watcher_thread = thread::spawn(move || {
            run_watcher_thread(
                WatcherThreadInput {
                    root_dir,
                    state_path,
                    filter,
                    queue,
                    callback,
                    stop: stop_for_thread,
                    debounce: Duration::from_millis(debounce_ms),
                    buffer_capacity,
                },
                rx,
            );
        });

        let mut guard = self
            .watcher
            .lock()
            .map_err(|_| napi_error("watcher-error", "Watcher lock is poisoned."))?;
        if let Some(mut existing) = guard.take() {
            existing.stop();
        }
        *guard = Some(NativeWatcher {
            watcher: Some(watcher),
            stop,
            thread: Some(watcher_thread),
        });

        encode(&WatcherStartResult {
            running: true,
            debounce_ms,
            buffer_capacity,
        })
    }

    #[napi(js_name = "drainWatcherEventsJson")]
    pub fn drain_watcher_events_json(&self) -> napi::Result<String> {
        let mut queue = self
            .watcher_queue
            .lock()
            .map_err(|_| napi_error("watcher-error", "Watcher event buffer lock is poisoned."))?;
        let batches = queue.drain(..).collect::<Vec<_>>();
        encode(&batches)
    }

    #[napi(js_name = "stopWatcher")]
    pub fn stop_watcher(&self) {
        if let Ok(mut guard) = self.watcher.lock() {
            if let Some(mut watcher) = guard.take() {
                watcher.stop();
            }
        }
    }

    #[napi(js_name = "writeEventJson")]
    pub fn write_event_json(&self, request: String) -> napi::Result<()> {
        let request: WriteEventRequest = decode(&request)?;
        let id = request
            .event
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| napi_error("invalid-engine-payload", "Canon event is missing id."))?;
        let event_type = request
            .event
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| napi_error("invalid-engine-payload", "Canon event is missing type."))?;
        let timestamp = request
            .event
            .get("timestamp")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                napi_error(
                    "invalid-engine-payload",
                    "Canon event is missing timestamp.",
                )
            })?;
        let payload = serde_json::to_string(&request.event)
            .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        conn.execute(
            "insert into canon_events(id, type, timestamp, payload) values (?1, ?2, ?3, ?4)
             on conflict(id) do update set type = excluded.type, timestamp = excluded.timestamp, payload = excluded.payload",
            params![id, event_type, timestamp, payload],
        )
        .map_err(|error| sqlite_error("Could not write canon event", error))?;
        Ok(())
    }

    #[napi(js_name = "listEventsJson")]
    pub fn list_events_json(&self, request: String) -> napi::Result<String> {
        let request: ListEventsRequest = decode(&request)?;
        let limit = request.limit.unwrap_or(50).clamp(1, 500);
        let conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        let mut statement = conn
            .prepare("select payload from canon_events order by timestamp desc limit ?1")
            .map_err(|error| sqlite_error("Could not prepare canon event list", error))?;
        let rows = statement
            .query_map(params![limit], |row| row.get::<_, String>(0))
            .map_err(|error| sqlite_error("Could not list canon events", error))?;
        let mut events = Vec::new();
        for row in rows {
            let payload =
                row.map_err(|error| sqlite_error("Could not decode canon event", error))?;
            let value = serde_json::from_str::<serde_json::Value>(&payload)
                .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
            events.push(value);
        }
        encode(&events)
    }

    #[napi(js_name = "writeObservabilityRecordsJson")]
    pub fn write_observability_records_json(&self, request: String) -> napi::Result<()> {
        let request: WriteObservabilityRecordsRequest = decode(&request)?;
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        let tx = conn
            .transaction()
            .map_err(|error| sqlite_error("Could not start observability transaction", error))?;

        let mut sink = SqliteObservationSink {
            tx: &tx,
            root_dir: &self.root_dir,
        };
        sink.write_batch(ObservationBatch {
            traces: &request.traces,
            spans: &request.spans,
            events: &request.events,
        })?;

        tx.commit()
            .map_err(|error| sqlite_error("Could not commit observability transaction", error))?;
        Ok(())
    }

    #[napi(js_name = "listObservabilityRecordsJson")]
    pub fn list_observability_records_json(&self, request: String) -> napi::Result<String> {
        let request: ListObservabilityRecordsRequest = decode(&request)?;
        let limit = request.limit.unwrap_or(50).clamp(1, 500);
        let conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        let trace_id = request.trace_id.as_deref();
        let traces = list_observability_payloads(
            &conn,
            &self.root_dir,
            "observability_traces",
            "coalesce(ended_at, started_at)",
            "id",
            trace_id,
            limit,
        )?;
        let spans = list_observability_payloads(
            &conn,
            &self.root_dir,
            "observability_spans",
            "coalesce(ended_at, started_at)",
            "trace_id",
            trace_id,
            limit,
        )?;
        let events = list_observability_payloads(
            &conn,
            &self.root_dir,
            "observability_events",
            "occurred_at",
            "trace_id",
            trace_id,
            limit,
        )?;
        encode(&json!({ "traces": traces, "spans": spans, "events": events }))
    }

    #[napi(js_name = "writeSemanticIndexJson")]
    pub fn write_semantic_index_json(&self, request: String) -> napi::Result<()> {
        let request: WriteSemanticIndexRequest = decode(&request)?;
        validate_semantic_index_request(&request)?;

        let mut conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        let previous_index = read_semantic_index_payload(&conn, &self.root_dir, &request.index.id)?;
        let previous_identity = previous_index
            .as_ref()
            .and_then(|index| index.get("identityHash"))
            .and_then(Value::as_str);
        let mut existing_chunks =
            read_semantic_chunk_hashes(&conn, &self.root_dir, &request.index.id)?;
        let incoming_ids = request
            .chunks
            .iter()
            .map(|chunk| chunk.metadata.id.clone())
            .collect::<HashSet<_>>();
        let vector_dir = semantic_vector_dir(&self.state_path, &request.index.id);
        let reset_vectors =
            previous_identity != Some(request.index.identity_hash.as_str()) || !vector_dir.exists();
        let mut reset_sql_chunks = reset_vectors;
        let vector_config =
            VectorConfig::with_dimensions(request.index.provider.dimensions as usize);
        if reset_vectors && vector_dir.exists() {
            fs::remove_dir_all(&vector_dir).map_err(|error| {
                napi_error(
                    "invalid-engine-payload",
                    &format!("Could not reset semantic vector store: {error}"),
                )
            })?;
        }
        let mut vector_db = if reset_vectors {
            fs::create_dir_all(&vector_dir).map_err(|error| {
                napi_error(
                    "invalid-engine-payload",
                    &format!("Could not create semantic vector store: {error}"),
                )
            })?;
            existing_chunks.clear();
            EmbeddingDb::create(&vector_dir, vector_config.clone()).map_err(vector_error)?
        } else {
            match EmbeddingDb::open_with_config(&vector_dir, Some(vector_config.clone())) {
                Ok(db) => db,
                Err(error) => {
                    fs::remove_dir_all(&vector_dir).map_err(|remove_error| {
                        napi_error(
                            "invalid-engine-payload",
                            &format!(
                                "Could not recover corrupted semantic vector store after open error ({error}): {remove_error}"
                            ),
                        )
                    })?;
                    fs::create_dir_all(&vector_dir).map_err(|create_error| {
                        napi_error(
                            "invalid-engine-payload",
                            &format!(
                                "Could not recreate semantic vector store after open error ({error}): {create_error}"
                            ),
                        )
                    })?;
                    existing_chunks.clear();
                    reset_sql_chunks = true;
                    EmbeddingDb::create(&vector_dir, vector_config.clone()).map_err(vector_error)?
                }
            }
        };

        for chunk in request.chunks.iter() {
            let existing_hash = existing_chunks.get(&chunk.metadata.id);
            if existing_hash != Some(&chunk.metadata.embedding_hash) && chunk.vector.is_empty() {
                return Err(napi_error(
                    "invalid-engine-payload",
                    &format!(
                        "Semantic chunk {} cannot reuse a missing or changed vector.",
                        chunk.metadata.id
                    ),
                ));
            }
        }

        if let Err(error) = write_semantic_vectors(
            &mut vector_db,
            &existing_chunks,
            &incoming_ids,
            &request.chunks,
        ) {
            if !semantic_vector_error_is_recoverable(&error)
                || request.chunks.iter().any(|chunk| chunk.vector.is_empty())
            {
                return Err(vector_error(error));
            }
            if vector_dir.exists() {
                fs::remove_dir_all(&vector_dir).map_err(|remove_error| {
                    napi_error(
                        "invalid-engine-payload",
                        &format!(
                            "Could not recover corrupted semantic vector store after write error ({error}): {remove_error}"
                        ),
                    )
                })?;
            }
            fs::create_dir_all(&vector_dir).map_err(|create_error| {
                napi_error(
                    "invalid-engine-payload",
                    &format!(
                        "Could not recreate semantic vector store after write error ({error}): {create_error}"
                    ),
                )
            })?;
            let mut recovered_vector_db =
                EmbeddingDb::create(&vector_dir, vector_config.clone()).map_err(vector_error)?;
            existing_chunks.clear();
            reset_sql_chunks = true;
            write_semantic_vectors(
                &mut recovered_vector_db,
                &existing_chunks,
                &incoming_ids,
                &request.chunks,
            )
            .map_err(vector_error)?;
        }

        let indexed_at = request.index.indexed_at.clone();
        let diagnostics_json = serde_json::to_string(&request.index.diagnostics)
            .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
        let index_payload = serde_json::to_string(&request.index)
            .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;

        let tx = conn
            .transaction()
            .map_err(|error| sqlite_error("Could not start semantic index transaction", error))?;
        tx.execute(
            "insert into semantic_index_snapshots(root_dir, id, version, status, provider_id,
               provider_display_name, model_id, model_digest, dimensions, distance, config_hash,
               chunker_version, producer_version, source_inventory_hash, identity_hash, chunk_count,
               vector_count, stale_chunk_count, diagnostics, payload, indexed_at, updated_at, chunk_tree_hash)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
             on conflict(root_dir, id) do update set
               version = excluded.version,
               status = excluded.status,
               provider_id = excluded.provider_id,
               provider_display_name = excluded.provider_display_name,
               model_id = excluded.model_id,
               model_digest = excluded.model_digest,
               dimensions = excluded.dimensions,
               distance = excluded.distance,
               config_hash = excluded.config_hash,
               chunker_version = excluded.chunker_version,
               producer_version = excluded.producer_version,
               source_inventory_hash = excluded.source_inventory_hash,
               identity_hash = excluded.identity_hash,
               chunk_count = excluded.chunk_count,
               vector_count = excluded.vector_count,
               stale_chunk_count = excluded.stale_chunk_count,
               diagnostics = excluded.diagnostics,
               payload = excluded.payload,
               indexed_at = excluded.indexed_at,
               updated_at = excluded.updated_at,
               chunk_tree_hash = excluded.chunk_tree_hash",
            params![
                self.root_dir,
                request.index.id,
                request.index.version,
                request.index.status,
                request.index.provider.id,
                request.index.provider.display_name,
                request.index.provider.model_id,
                request.index.provider.model_digest,
                request.index.provider.dimensions,
                request.index.provider.distance,
                request.index.provider.config_hash,
                request.index.chunker_version,
                request.index.producer_version,
                request.index.source_inventory_hash,
                request.index.identity_hash,
                request.index.chunk_count,
                request.index.vector_count,
                request.index.stale_chunk_count,
                diagnostics_json,
                index_payload,
                indexed_at,
                timestamp(),
                request.index.chunk_tree_hash,
            ],
        )
        .map_err(|error| sqlite_error("Could not write semantic index snapshot", error))?;

        if reset_sql_chunks {
            tx.execute(
                "delete from semantic_chunks where root_dir = ?1 and index_id = ?2",
                params![self.root_dir, request.index.id],
            )
            .map_err(|error| sqlite_error("Could not reset semantic chunks", error))?;
        } else {
            for removed_id in existing_chunks.keys() {
                if incoming_ids.contains(removed_id) {
                    continue;
                }
                tx.execute(
                    "delete from semantic_chunks where root_dir = ?1 and index_id = ?2 and id = ?3",
                    params![self.root_dir, request.index.id, removed_id],
                )
                .map_err(|error| sqlite_error("Could not delete stale semantic chunk", error))?;
            }
        }
        tx.execute(
            "delete from semantic_chunks_fts where root_dir = ?1 and index_id = ?2",
            params![self.root_dir, request.index.id],
        )
        .map_err(|error| sqlite_error("Could not clear semantic search text", error))?;

        for chunk in request.chunks.iter() {
            let metadata = &chunk.metadata;
            let payload = serde_json::to_string(metadata)
                .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
            tx.execute(
                "insert into semantic_chunks(root_dir, index_id, id, path, content_hash, chunk_hash,
                   embedding_hash, kind, language, ordinal, start_line, start_column, start_byte,
                   end_line, end_column, end_byte, heading, symbol, token_estimate, preview, payload, indexed_at, text)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
                 on conflict(root_dir, index_id, id) do update set
                   path = excluded.path,
                   content_hash = excluded.content_hash,
                   chunk_hash = excluded.chunk_hash,
                   embedding_hash = excluded.embedding_hash,
                   kind = excluded.kind,
                   language = excluded.language,
                   ordinal = excluded.ordinal,
                   start_line = excluded.start_line,
                   start_column = excluded.start_column,
                   start_byte = excluded.start_byte,
                   end_line = excluded.end_line,
                   end_column = excluded.end_column,
                   end_byte = excluded.end_byte,
                   heading = excluded.heading,
                   symbol = excluded.symbol,
                   token_estimate = excluded.token_estimate,
                   preview = excluded.preview,
                   payload = excluded.payload,
                   indexed_at = excluded.indexed_at,
                   text = excluded.text",
                params![
                    self.root_dir,
                    request.index.id,
                    metadata.id,
                    metadata.path,
                    metadata.content_hash,
                    metadata.chunk_hash,
                    metadata.embedding_hash,
                    metadata.kind,
                    metadata.language,
                    metadata.ordinal,
                    metadata.range.start.line,
                    metadata.range.start.column,
                    metadata.range.start.byte,
                    metadata.range.end.line,
                    metadata.range.end.column,
                    metadata.range.end.byte,
                    metadata.heading,
                    metadata.symbol,
                    metadata.token_estimate,
                    metadata.preview,
                    payload,
                    indexed_at,
                    chunk.text,
                ],
            )
            .map_err(|error| sqlite_error("Could not write semantic chunk metadata", error))?;
            tx.execute(
                "insert into semantic_chunks_fts(root_dir, index_id, id, path, heading, symbol, language, kind, preview, text)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    self.root_dir,
                    request.index.id,
                    metadata.id,
                    metadata.path,
                    metadata.heading,
                    metadata.symbol,
                    metadata.language,
                    metadata.kind,
                    metadata.preview,
                    chunk.text,
                ],
            )
            .map_err(|error| sqlite_error("Could not write semantic search text", error))?;
        }

        tx.commit()
            .map_err(|error| sqlite_error("Could not commit semantic index transaction", error))?;
        Ok(())
    }

    #[napi(js_name = "readSemanticIndexStatusJson")]
    pub fn read_semantic_index_status_json(&self, request: String) -> napi::Result<String> {
        let request: ReadSemanticIndexStatusRequest = decode(&request)?;
        let index_id = request
            .index_id
            .unwrap_or_else(|| default_semantic_index_id().to_string());
        let conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        let index = read_semantic_index_payload(&conn, &self.root_dir, &index_id)?;
        encode(&json!({ "index": index }))
    }

    #[napi(js_name = "listSemanticChunksJson")]
    pub fn list_semantic_chunks_json(&self, request: String) -> napi::Result<String> {
        let request: ListSemanticChunksRequest = decode(&request)?;
        let index_id = request
            .index_id
            .unwrap_or_else(|| default_semantic_index_id().to_string());
        let limit = request.limit.unwrap_or(100).clamp(1, 500) as usize;
        let offset = request.offset.unwrap_or(0) as usize;
        let conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        let Some(index) = read_semantic_index_payload(&conn, &self.root_dir, &index_id)? else {
            return encode(&json!({ "index": null, "chunks": [] }));
        };
        let chunks = list_semantic_chunk_payloads(
            &conn,
            &self.root_dir,
            &index_id,
            &request.paths,
            limit,
            offset,
        )?;
        encode(&json!({ "index": index, "chunks": chunks }))
    }

    #[napi(js_name = "searchSemanticIndexJson")]
    pub fn search_semantic_index_json(&self, request: String) -> napi::Result<String> {
        let request: SearchSemanticIndexRequest = decode(&request)?;
        let index_id = request
            .index_id
            .unwrap_or_else(|| default_semantic_index_id().to_string());
        let limit = request.limit.unwrap_or(20).clamp(1, 100) as usize;
        let conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        let Some(index) = read_semantic_index_payload(&conn, &self.root_dir, &index_id)? else {
            return encode(&json!({ "index": null, "results": [] }));
        };
        let dimensions = json_object_field(&index, "provider")
            .and_then(|provider| json_int_field(provider, "dimensions"))?;
        if let Some(vector) = request.vector.as_ref() {
            if vector.len() != dimensions as usize {
                return Err(napi_error(
                    "invalid-engine-payload",
                    &format!(
                        "Semantic search vector dimension mismatch: expected {dimensions}, got {}.",
                        vector.len()
                    ),
                ));
            }
        }

        let candidate_limit = limit.saturating_mul(4).max(limit);
        let mut scores: HashMap<String, (Option<f32>, Option<f32>)> = HashMap::new();
        if let Some(vector) = request.vector.as_ref() {
            let vector_dir = semantic_vector_dir(&self.state_path, &index_id);
            if vector_dir.exists() {
                let vector_db = EmbeddingDb::open(&vector_dir).map_err(vector_error)?;
                let matches = if request.paths.is_empty() {
                    vector_db.search(vector, candidate_limit)
                } else {
                    let allowed_ids = semantic_chunk_ids_for_paths(
                        &conn,
                        &self.root_dir,
                        &index_id,
                        &request.paths,
                    )?;
                    vector_db.search_filtered(vector, candidate_limit, &allowed_ids)
                };
                for item in matches {
                    scores.entry(item.id).or_default().0 = Some(item.score);
                }
            }
        }
        if let Some(query) = request.query.as_deref() {
            let lexical = semantic_lexical_matches(
                &conn,
                &self.root_dir,
                &index_id,
                query,
                candidate_limit.saturating_mul(2),
            )?;
            for (rank, (id, _rank_score)) in lexical.into_iter().enumerate() {
                let score = 1.0_f32 / (rank as f32 + 1.0);
                scores.entry(id).or_default().1 = Some(score);
            }
        }

        let allowed_paths = request.paths.iter().cloned().collect::<HashSet<_>>();
        let mut ranked = Vec::new();
        for (id, (vector_score, lexical_score)) in scores {
            if let Some(chunk) = read_semantic_chunk_payload(&conn, &self.root_dir, &index_id, &id)?
            {
                if !allowed_paths.is_empty() {
                    let Some(path) = chunk.get("path").and_then(Value::as_str) else {
                        continue;
                    };
                    if !allowed_paths.contains(path) {
                        continue;
                    }
                }
                let combined = match (vector_score, lexical_score) {
                    (Some(vector), Some(lexical)) => (vector * 0.7) + (lexical * 0.3),
                    (Some(vector), None) => vector * 0.95,
                    (None, Some(lexical)) => lexical * 0.85,
                    (None, None) => 0.0,
                };
                let mut score_parts = serde_json::Map::new();
                if let Some(score) = vector_score {
                    score_parts.insert("vector".to_string(), json!(score));
                }
                if let Some(score) = lexical_score {
                    score_parts.insert("lexical".to_string(), json!(score));
                }
                score_parts.insert("combined".to_string(), json!(combined));
                ranked.push((
                    combined,
                    json!({ "chunk": chunk, "score": combined, "scores": Value::Object(score_parts) }),
                ));
            }
        }
        ranked.sort_by(|left, right| {
            right
                .0
                .partial_cmp(&left.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let results = ranked
            .into_iter()
            .take(limit)
            .map(|(_, result)| result)
            .collect::<Vec<_>>();
        encode(&json!({ "index": index, "results": results }))
    }

    #[napi(js_name = "embedSemanticTextsJson")]
    pub fn embed_semantic_texts_json(&self, request: String) -> napi::Result<String> {
        let request: EmbedSemanticTextsRequest = decode(&request)?;
        let model_id = request.model_id.trim();
        if model_id.is_empty() {
            return Err(napi_error(
                "invalid-engine-payload",
                "Semantic embedding model id is required.",
            ));
        }
        if request.texts.is_empty() {
            return Err(napi_error(
                "invalid-engine-payload",
                "Semantic embedding request must include at least one text.",
            ));
        }
        if let Some(index) = request.texts.iter().position(|text| text.trim().is_empty()) {
            return Err(napi_error(
                "invalid-engine-payload",
                &format!("Semantic embedding text at index {index} is empty."),
            ));
        }
        if request.task != "document" && request.task != "query" {
            return Err(napi_error(
                "invalid-engine-payload",
                "Semantic embedding task must be document or query.",
            ));
        }

        let embedder = self.semantic_embedder(&request)?;
        let text_refs = request.texts.iter().map(String::as_str).collect::<Vec<_>>();
        let vectors = match request.task.as_str() {
            "document" => embedder.embed_batch(&text_refs),
            "query" => embedder.embed_query_batch(&text_refs),
            _ => unreachable!("semantic embedding task was validated before model loading"),
        }
        .map_err(inference_error)?;

        encode(&json!({
          "modelId": embedder.model_id(),
          "dimensions": embedder.dimensions(),
          "vectors": vectors,
        }))
    }

    #[napi(js_name = "generateTextJson")]
    pub fn generate_text_json(&self, request: String) -> napi::Result<String> {
        let request: GenerateTextRequest = decode(&request)?;
        let model_id = request.model_id.trim();
        if model_id.is_empty() {
            return Err(napi_error(
                "invalid-engine-payload",
                "Generation model id is required.",
            ));
        }
        if request.prompt.trim().is_empty() {
            return Err(napi_error(
                "invalid-engine-payload",
                "Generation prompt is required.",
            ));
        }
        let options = generation_options(&request)?;
        let generator = self.generator(&request)?;
        let text = generator
            .generate(&request.prompt, Some(options))
            .map_err(inference_error)?;

        encode(&json!({
          "modelId": generator.model_id(),
          "text": text,
        }))
    }

    #[napi(js_name = "writeProductModelProjectionJson")]
    pub fn write_product_model_projection_json(&self, request: String) -> napi::Result<()> {
        let request: WriteProductModelProjectionRequest = decode(&request)?;
        let projection = request.projection;
        let indexed_at = json_string_field(&projection, "indexedAt")?.to_string();
        let graph_hash = json_string_field(&projection, "graphHash")?.to_string();
        let definitions_hash = json_string_field(&projection, "definitionsHash")?.to_string();
        let counts = json_object_field(&projection, "counts")?;
        let definition_graph = json_object_field(&projection, "definitionGraph")?;
        let nodes = json_array_field(definition_graph, "nodes")?;
        let edges = json_array_field(definition_graph, "edges")?;
        let diagnostics = json_array_field(definition_graph, "diagnostics")?;
        let payload = serde_json::to_string(&projection)
            .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;

        let mut conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        let tx = conn
            .transaction()
            .map_err(|error| sqlite_error("Could not start product model transaction", error))?;
        tx.execute(
            "delete from product_model_snapshots where root_dir = ?1",
            params![self.root_dir],
        )
        .map_err(|error| sqlite_error("Could not clear product model projection", error))?;
        tx.execute(
            "insert into product_model_snapshots(root_dir, graph_hash, definitions_hash,
               area_count, spec_count, change_count, convention_count, impact_surface_count, validator_count,
               node_count, edge_count, diagnostic_count, payload, indexed_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                self.root_dir,
                graph_hash,
                definitions_hash,
                json_int_field(counts, "areas")?,
                json_int_field(counts, "specs")?,
                json_int_field(counts, "changes")?,
                json_int_field(counts, "conventions")?,
                json_int_field(counts, "impactSurfaces")?,
                json_int_field(counts, "validators")?,
                json_int_field(counts, "nodes")?,
                json_int_field(counts, "edges")?,
                json_int_field(counts, "diagnostics")?,
                payload,
                indexed_at,
            ],
        )
        .map_err(|error| sqlite_error("Could not write product model projection", error))?;

        for node in nodes {
            let node_id = json_string_field(node, "id")?;
            let node_payload = serde_json::to_string(node)
                .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
            tx.execute(
                "insert into product_model_nodes(root_dir, id, kind, label, payload, indexed_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    self.root_dir,
                    node_id,
                    json_string_field(node, "kind")?,
                    json_string_field(node, "label")?,
                    node_payload,
                    indexed_at,
                ],
            )
            .map_err(|error| sqlite_error("Could not write product model node", error))?;
        }

        for edge in edges {
            let from = json_string_field(edge, "from")?;
            let to = json_string_field(edge, "to")?;
            let kind = json_string_field(edge, "kind")?;
            let label = json_optional_string_field(edge, "label");
            let edge_payload = serde_json::to_string(edge)
                .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
            let edge_id = stable_projection_row_id(&[from, kind, to, label.unwrap_or("")]);
            tx.execute(
                "insert into product_model_edges(root_dir, id, from_node_id, to_node_id, kind, label, payload, indexed_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![self.root_dir, edge_id, from, to, kind, label, edge_payload, indexed_at],
            )
            .map_err(|error| sqlite_error("Could not write product model edge", error))?;
        }

        for diagnostic in diagnostics {
            let severity = json_string_field(diagnostic, "severity")?;
            let code = json_string_field(diagnostic, "code")?;
            let message = json_string_field(diagnostic, "message")?;
            let from = json_optional_string_field(diagnostic, "from");
            let to = json_optional_string_field(diagnostic, "to");
            let diagnostic_payload = serde_json::to_string(diagnostic)
                .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
            let diagnostic_id = stable_projection_row_id(&[
                severity,
                code,
                from.unwrap_or(""),
                to.unwrap_or(""),
                message,
            ]);
            tx.execute(
                "insert into product_model_diagnostics(root_dir, id, severity, code, from_node_id, to_node_id, message, payload, indexed_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    self.root_dir,
                    diagnostic_id,
                    severity,
                    code,
                    from,
                    to,
                    message,
                    diagnostic_payload,
                    indexed_at,
                ],
            )
            .map_err(|error| sqlite_error("Could not write product model diagnostic", error))?;
        }

        tx.commit()
            .map_err(|error| sqlite_error("Could not commit product model transaction", error))?;
        Ok(())
    }

    #[napi(js_name = "readProductModelProjectionJson")]
    pub fn read_product_model_projection_json(&self) -> napi::Result<String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        let payload = conn
            .query_row(
                "select payload from product_model_snapshots where root_dir = ?1",
                params![self.root_dir],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| sqlite_error("Could not read product model projection", error))?;
        let projection = match payload {
            Some(payload) => Some(
                serde_json::from_str::<Value>(&payload)
                    .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?,
            ),
            None => None,
        };
        encode(&json!({ "projection": projection }))
    }
}

impl EngineProjectHandle {
    pub(crate) fn open(request: OpenProjectRequest) -> napi::Result<Self> {
        if let Some(parent) = Path::new(&request.state_path).parent() {
            fs::create_dir_all(parent).map_err(|error| {
                napi_error(
                    "state-path-unwritable",
                    &format!("Could not create state directory: {error}"),
                )
            })?;
        }
        let OpenProjectRequest {
            root_dir,
            state_path,
            settings,
        } = request;
        let (conn, migrations_applied) = open_project_connection(&state_path, &settings)?;

        Ok(Self {
            root_dir,
            state_path,
            settings,
            migrations_applied,
            conn: Mutex::new(conn),
            watcher_queue: Arc::new(Mutex::new(VecDeque::new())),
            watcher: Mutex::new(None),
            embedding_cache: Mutex::new(HashMap::new()),
            generation_cache: Mutex::new(HashMap::new()),
        })
    }

    fn semantic_embedder(&self, request: &EmbedSemanticTextsRequest) -> napi::Result<Embedder> {
        let model_id = request.model_id.trim();
        let n_gpu_layers = request.n_gpu_layers.unwrap_or(u32::MAX);
        let n_threads = request.n_threads.unwrap_or(8);
        let n_ctx = request.n_ctx;
        let cache_key = format!(
            "model={model_id};gpu={n_gpu_layers};threads={n_threads};ctx={}",
            n_ctx.map_or_else(|| "default".to_string(), |value| value.to_string())
        );
        {
            let cache = self.embedding_cache.lock().map_err(|_| {
                napi_error(
                    "inference-error",
                    "Semantic embedding cache lock is poisoned.",
                )
            })?;
            if let Some(embedder) = cache.get(&cache_key) {
                return Ok(embedder.clone());
            }
        }

        let mut config = EmbedderConfig::default()
            .with_model(model_id)
            .map_err(inference_error)?;
        config.n_gpu_layers = n_gpu_layers;
        config.n_threads = n_threads;
        config.n_ctx = n_ctx;
        config.show_download_progress = request.show_download_progress;
        let embedder = Embedder::new(config).map_err(inference_error)?;
        let mut cache = self.embedding_cache.lock().map_err(|_| {
            napi_error(
                "inference-error",
                "Semantic embedding cache lock is poisoned.",
            )
        })?;
        let cached = cache.entry(cache_key).or_insert(embedder).clone();
        Ok(cached)
    }

    fn generator(&self, request: &GenerateTextRequest) -> napi::Result<Generator> {
        let model_id = request.model_id.trim();
        let n_gpu_layers = request.n_gpu_layers.unwrap_or(u32::MAX);
        let n_threads = request.n_threads.unwrap_or(8);
        let n_ctx = request.n_ctx.unwrap_or(2048);
        let cache_key =
            format!("model={model_id};gpu={n_gpu_layers};threads={n_threads};ctx={n_ctx}");
        {
            let cache = self
                .generation_cache
                .lock()
                .map_err(|_| napi_error("inference-error", "Generation cache lock is poisoned."))?;
            if let Some(generator) = cache.get(&cache_key) {
                return Ok(generator.clone());
            }
        }

        let mut config = GeneratorConfig::default()
            .with_model(model_id)
            .map_err(inference_error)?;
        config.n_gpu_layers = n_gpu_layers;
        config.n_threads = n_threads;
        config.n_ctx = n_ctx;
        config.show_download_progress = request.show_download_progress;
        let generator = Generator::new(config).map_err(inference_error)?;
        let mut cache = self
            .generation_cache
            .lock()
            .map_err(|_| napi_error("inference-error", "Generation cache lock is poisoned."))?;
        let cached = cache.entry(cache_key).or_insert(generator).clone();
        Ok(cached)
    }

    fn project_refresh_status(&self) -> napi::Result<ProjectRefreshStatus> {
        let running = self
            .watcher
            .lock()
            .map_err(|_| napi_error("watcher-error", "Watcher lock is poisoned."))?
            .is_some();
        let buffered_events = self
            .watcher_queue
            .lock()
            .map_err(|_| napi_error("watcher-error", "Watcher event buffer lock is poisoned."))?
            .len();
        let conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        let state = read_watch_state_status(&conn, &self.root_dir)?;
        let status = if running && !state.0 { "live" } else { "stale" }.to_string();
        let mode = if running { "watch" } else { "manual" }.to_string();
        let reason = if running {
            state.1
        } else {
            state.1.or_else(|| {
                Some("File watching is not running; manual refresh is required.".to_string())
            })
        };
        Ok(ProjectRefreshStatus {
            status,
            mode,
            buffered_events,
            reason,
        })
    }
}

const SQLITE_OPEN_ATTEMPTS: usize = 4;
const SQLITE_OPEN_RETRY_DELAY_MS: u64 = 250;
const SQLITE_BUSY_TIMEOUT_SECS: u64 = 10;

fn open_project_connection(
    state_path: &str,
    settings: &ResolvedProjectSettings,
) -> napi::Result<(Connection, Vec<u32>)> {
    let mut last_busy_message: Option<String> = None;
    for attempt in 0..SQLITE_OPEN_ATTEMPTS {
        match try_open_project_connection(state_path, settings) {
            Ok(result) => return Ok(result),
            Err(error)
                if sqlite_error_is_busy_or_locked(&error) && attempt + 1 < SQLITE_OPEN_ATTEMPTS =>
            {
                last_busy_message = Some(error.to_string());
                thread::sleep(Duration::from_millis(SQLITE_OPEN_RETRY_DELAY_MS));
            }
            Err(error) => return Err(error),
        }
    }

    Err(napi_error(
        "sqlite-error",
        &format!(
            "Could not initialize project state database after waiting for SQLite locks to clear: {}",
            last_busy_message.unwrap_or_else(|| "unknown SQLite lock".to_string())
        ),
    ))
}

fn try_open_project_connection(
    state_path: &str,
    settings: &ResolvedProjectSettings,
) -> napi::Result<(Connection, Vec<u32>)> {
    let conn = Connection::open(state_path)
        .map_err(|error| sqlite_error("Could not open project state database", error))?;
    conn.busy_timeout(Duration::from_secs(SQLITE_BUSY_TIMEOUT_SECS))
        .map_err(|error| sqlite_error("Could not set SQLite busy timeout", error))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| sqlite_error("Could not enable SQLite WAL mode", error))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| sqlite_error("Could not set SQLite synchronous mode", error))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| sqlite_error("Could not enable SQLite foreign keys", error))?;
    let migrations_applied = migrate_state(&conn)?;
    conn.execute(
        "insert into meta(key, value) values (?1, ?2)
         on conflict(key) do update set value = excluded.value",
        params![
            "projectSettings",
            serde_json::to_string(settings).unwrap_or_default()
        ],
    )
    .map_err(|error| sqlite_error("Could not persist project settings", error))?;
    Ok((conn, migrations_applied))
}

fn sqlite_error_is_busy_or_locked(error: &napi::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("database is locked")
        || message.contains("database is busy")
        || message.contains("sqlite_busy")
        || message.contains("sqlite_locked")
}

struct SqliteObservationSink<'a> {
    tx: &'a rusqlite::Transaction<'a>,
    root_dir: &'a str,
}

impl ObservationSink for SqliteObservationSink<'_> {
    fn write_trace(&mut self, trace: &Value) -> napi::Result<()> {
        write_observability_trace(self.tx, self.root_dir, trace)
    }

    fn write_span(&mut self, span: &Value) -> napi::Result<()> {
        write_observability_span(self.tx, self.root_dir, span)
    }

    fn write_event(&mut self, event: &Value) -> napi::Result<()> {
        write_observability_event(self.tx, self.root_dir, event)
    }
}

fn default_semantic_index_id() -> &'static str {
    "project"
}

fn semantic_vector_dir(state_path: &str, index_id: &str) -> PathBuf {
    let parent = Path::new(state_path)
        .parent()
        .unwrap_or_else(|| Path::new("."));
    parent
        .join("semantic-index")
        .join(sanitize_state_segment(index_id))
}

fn sanitize_state_segment(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
            output.push(character);
        } else {
            output.push('_');
        }
    }
    if output.is_empty() {
        default_semantic_index_id().to_string()
    } else {
        output
    }
}

fn validate_semantic_index_request(request: &WriteSemanticIndexRequest) -> napi::Result<()> {
    if request.index.id.trim().is_empty() {
        return Err(napi_error(
            "invalid-engine-payload",
            "Semantic index id is required.",
        ));
    }
    if request.index.provider.dimensions == 0 {
        return Err(napi_error(
            "invalid-engine-payload",
            "Semantic index dimensions must be positive.",
        ));
    }
    if request.index.provider.kind.trim().is_empty()
        || request.index.chunk_tree_hash.trim().is_empty()
    {
        return Err(napi_error(
            "invalid-engine-payload",
            "Semantic index provider kind and chunk tree hash are required.",
        ));
    }
    if request.index.provider.distance != "cosine" {
        return Err(napi_error(
            "invalid-engine-payload",
            "Semantic index distance must be cosine.",
        ));
    }
    if request.index.chunk_count as usize != request.chunks.len()
        || request.index.vector_count as usize != request.chunks.len()
    {
        return Err(napi_error(
            "invalid-engine-payload",
            &format!(
                "Semantic index counts must match chunk payload length: chunkCount={}, vectorCount={}, chunks={}.",
                request.index.chunk_count,
                request.index.vector_count,
                request.chunks.len()
            ),
        ));
    }
    for chunk in request.chunks.iter() {
        if !chunk.vector.is_empty()
            && chunk.vector.len() != request.index.provider.dimensions as usize
        {
            return Err(napi_error(
                "invalid-engine-payload",
                &format!(
                    "Semantic chunk {} vector dimension mismatch: expected {}, got {}.",
                    chunk.metadata.id,
                    request.index.provider.dimensions,
                    chunk.vector.len()
                ),
            ));
        }
        if chunk.metadata.id.trim().is_empty()
            || chunk.metadata.path.trim().is_empty()
            || chunk.metadata.chunk_hash.trim().is_empty()
            || chunk.metadata.embedding_hash.trim().is_empty()
            || chunk.text.trim().is_empty()
        {
            return Err(napi_error(
                "invalid-engine-payload",
                "Semantic chunk metadata or search text is missing required identity fields.",
            ));
        }
    }
    Ok(())
}

fn read_semantic_index_payload(
    conn: &Connection,
    root_dir: &str,
    index_id: &str,
) -> napi::Result<Option<Value>> {
    let payload = conn
        .query_row(
            "select payload from semantic_index_snapshots where root_dir = ?1 and id = ?2",
            params![root_dir, index_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| sqlite_error("Could not read semantic index snapshot", error))?;
    payload
        .map(|payload| {
            serde_json::from_str::<Value>(&payload)
                .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))
        })
        .transpose()
}

fn read_semantic_chunk_payload(
    conn: &Connection,
    root_dir: &str,
    index_id: &str,
    chunk_id: &str,
) -> napi::Result<Option<Value>> {
    let payload = conn
        .query_row(
            "select payload from semantic_chunks where root_dir = ?1 and index_id = ?2 and id = ?3",
            params![root_dir, index_id, chunk_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| sqlite_error("Could not read semantic chunk", error))?;
    payload
        .map(|payload| {
            serde_json::from_str::<Value>(&payload)
                .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))
        })
        .transpose()
}

fn list_semantic_chunk_payloads(
    conn: &Connection,
    root_dir: &str,
    index_id: &str,
    paths: &[String],
    limit: usize,
    offset: usize,
) -> napi::Result<Vec<Value>> {
    if paths.is_empty() {
        let mut statement = conn
            .prepare(
                "select payload from semantic_chunks
                 where root_dir = ?1 and index_id = ?2
                 order by path, cast(json_extract(payload, '$.ordinal') as integer), id
                 limit ?3 offset ?4",
            )
            .map_err(|error| sqlite_error("Could not prepare semantic chunk list", error))?;
        let rows = statement
            .query_map(
                params![root_dir, index_id, limit as i64, offset as i64],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| sqlite_error("Could not list semantic chunks", error))?;
        let mut chunks = Vec::new();
        for row in rows {
            let payload =
                row.map_err(|error| sqlite_error("Could not decode semantic chunk", error))?;
            chunks.push(
                serde_json::from_str::<Value>(&payload)
                    .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?,
            );
        }
        return Ok(chunks);
    }

    let allowed_paths = paths.iter().cloned().collect::<HashSet<_>>();
    let mut statement = conn
        .prepare(
            "select payload from semantic_chunks
             where root_dir = ?1 and index_id = ?2
             order by path, cast(json_extract(payload, '$.ordinal') as integer), id",
        )
        .map_err(|error| sqlite_error("Could not prepare filtered semantic chunk list", error))?;
    let rows = statement
        .query_map(params![root_dir, index_id], |row| row.get::<_, String>(0))
        .map_err(|error| sqlite_error("Could not list filtered semantic chunks", error))?;
    let mut chunks = Vec::new();
    for row in rows {
        let payload =
            row.map_err(|error| sqlite_error("Could not decode semantic chunk", error))?;
        let chunk = serde_json::from_str::<Value>(&payload)
            .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
        let Some(path) = chunk.get("path").and_then(Value::as_str) else {
            continue;
        };
        if allowed_paths.contains(path) {
            chunks.push(chunk);
        }
    }
    Ok(chunks.into_iter().skip(offset).take(limit).collect())
}

fn read_semantic_chunk_hashes(
    conn: &Connection,
    root_dir: &str,
    index_id: &str,
) -> napi::Result<HashMap<String, String>> {
    let mut statement = conn
        .prepare(
            "select id, embedding_hash from semantic_chunks where root_dir = ?1 and index_id = ?2",
        )
        .map_err(|error| sqlite_error("Could not prepare semantic chunk hash read", error))?;
    let rows = statement
        .query_map(params![root_dir, index_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| sqlite_error("Could not read semantic chunk hashes", error))?;
    let mut hashes = HashMap::new();
    for row in rows {
        let (id, hash) =
            row.map_err(|error| sqlite_error("Could not decode semantic chunk hash", error))?;
        hashes.insert(id, hash);
    }
    Ok(hashes)
}

fn write_semantic_vectors(
    vector_db: &mut EmbeddingDb,
    existing_chunks: &HashMap<String, String>,
    incoming_ids: &HashSet<String>,
    chunks: &[SemanticChunkEmbeddingRequest],
) -> Result<(), EmbedDbError> {
    for existing_id in existing_chunks.keys() {
        if !incoming_ids.contains(existing_id) {
            vector_db.delete(existing_id)?;
        }
    }

    let mut insert_ids = Vec::new();
    let mut insert_vectors = Vec::new();
    for chunk in chunks {
        let existing_hash = existing_chunks.get(&chunk.metadata.id);
        if existing_hash == Some(&chunk.metadata.embedding_hash) {
            continue;
        }
        if existing_hash.is_some() {
            vector_db.delete(&chunk.metadata.id)?;
        }
        insert_ids.push(chunk.metadata.id.clone());
        insert_vectors.push(chunk.vector.clone());
    }
    vector_db.insert_batch(&insert_ids, &insert_vectors)?;
    vector_db.flush()?;
    Ok(())
}

fn semantic_vector_error_is_recoverable(error: &EmbedDbError) -> bool {
    matches!(
        error,
        EmbedDbError::Corrupted(_) | EmbedDbError::DuplicateId(_) | EmbedDbError::Io(_)
    )
}

fn semantic_chunk_ids_for_paths(
    conn: &Connection,
    root_dir: &str,
    index_id: &str,
    paths: &[String],
) -> napi::Result<Vec<String>> {
    let mut ids = Vec::new();
    for path in paths {
        let mut statement = conn
            .prepare(
                "select id from semantic_chunks where root_dir = ?1 and index_id = ?2 and path = ?3",
            )
            .map_err(|error| sqlite_error("Could not prepare semantic chunk filter", error))?;
        let rows = statement
            .query_map(params![root_dir, index_id, path], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| sqlite_error("Could not filter semantic chunks", error))?;
        for row in rows {
            ids.push(
                row.map_err(|error| sqlite_error("Could not decode semantic chunk id", error))?,
            );
        }
    }
    Ok(ids)
}

fn semantic_lexical_matches(
    conn: &Connection,
    root_dir: &str,
    index_id: &str,
    query: &str,
    limit: usize,
) -> napi::Result<Vec<(String, f64)>> {
    let Some(match_query) = semantic_fts_query(query) else {
        return Ok(Vec::new());
    };
    let mut statement = conn
        .prepare(
            "select id, bm25(semantic_chunks_fts) as rank
             from semantic_chunks_fts
             where semantic_chunks_fts match ?1 and root_dir = ?2 and index_id = ?3
             order by rank
             limit ?4",
        )
        .map_err(|error| sqlite_error("Could not prepare semantic lexical search", error))?;
    let rows = statement
        .query_map(
            params![match_query, root_dir, index_id, limit as i64],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?)),
        )
        .map_err(|error| sqlite_error("Could not run semantic lexical search", error))?;
    let mut matches = Vec::new();
    for row in rows {
        matches.push(row.map_err(|error| sqlite_error("Could not decode lexical match", error))?);
    }
    Ok(matches)
}

fn semantic_fts_query(query: &str) -> Option<String> {
    let mut terms = Vec::new();
    let mut current = String::new();
    for character in query.chars() {
        if character.is_ascii_alphanumeric() || character == '_' {
            current.push(character.to_ascii_lowercase());
        } else if current.len() > 1 {
            terms.push(std::mem::take(&mut current));
        } else {
            current.clear();
        }
    }
    if current.len() > 1 {
        terms.push(current);
    }
    terms.sort();
    terms.dedup();
    if terms.is_empty() {
        return None;
    }
    Some(
        terms
            .into_iter()
            .take(16)
            .map(|term| format!("{term}*"))
            .collect::<Vec<_>>()
            .join(" OR "),
    )
}

fn generation_options(request: &GenerateTextRequest) -> napi::Result<GenerateOptions> {
    let defaults = GenerateOptions::default();
    let max_tokens = request.max_tokens.unwrap_or(defaults.max_tokens);
    if max_tokens == 0 || max_tokens > 4096 {
        return Err(napi_error(
            "invalid-engine-payload",
            "Generation maxTokens must be between 1 and 4096.",
        ));
    }
    let temperature = request.temperature.unwrap_or(defaults.temperature);
    if !(0.0..=2.0).contains(&temperature) {
        return Err(napi_error(
            "invalid-engine-payload",
            "Generation temperature must be between 0 and 2.",
        ));
    }
    let top_p = request.top_p.unwrap_or(defaults.top_p);
    if !(0.0..=1.0).contains(&top_p) {
        return Err(napi_error(
            "invalid-engine-payload",
            "Generation topP must be between 0 and 1.",
        ));
    }
    if request.n_threads.is_some_and(|value| value <= 0) {
        return Err(napi_error(
            "invalid-engine-payload",
            "Generation nThreads must be a positive integer.",
        ));
    }
    if request.n_ctx.is_some_and(|value| value == 0) {
        return Err(napi_error(
            "invalid-engine-payload",
            "Generation nCtx must be a positive integer.",
        ));
    }
    Ok(GenerateOptions {
        max_tokens,
        temperature,
        top_p,
        seed: request.seed.unwrap_or(defaults.seed),
    })
}

fn vector_error(error: EmbedDbError) -> napi::Error {
    napi_error("invalid-engine-payload", &error.to_string())
}

fn inference_error(error: InferenceError) -> napi::Error {
    napi_error("inference-error", &error.to_string())
}

fn write_observability_trace(
    tx: &rusqlite::Transaction<'_>,
    root_dir: &str,
    trace: &Value,
) -> napi::Result<()> {
    let attributes = json_payload_field(trace, "attributes")?;
    let resource = json_optional_payload_field(trace, "resource")?;
    let error = json_optional_payload_field(trace, "error")?;
    let payload = json_payload(trace)?;
    tx.execute(
        "insert into observability_traces(
           root_dir, id, name, status, recording, sampled, started_at, ended_at, duration_ms,
           parent_trace_id, trace_state, trace_flags, attributes, resource, error, payload
         ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         on conflict(root_dir, id) do update set
           name = excluded.name,
           status = excluded.status,
           recording = excluded.recording,
           sampled = excluded.sampled,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           duration_ms = excluded.duration_ms,
           parent_trace_id = excluded.parent_trace_id,
           trace_state = excluded.trace_state,
           trace_flags = excluded.trace_flags,
           attributes = excluded.attributes,
           resource = excluded.resource,
           error = excluded.error,
           payload = excluded.payload",
        params![
            root_dir,
            json_string_field(trace, "id")?,
            json_string_field(trace, "name")?,
            json_string_field(trace, "status")?,
            json_bool_field(trace, "recording")? as i64,
            json_bool_field(trace, "sampled")? as i64,
            json_string_field(trace, "startedAt")?,
            json_optional_string_field(trace, "endedAt"),
            json_optional_f64_field(trace, "durationMs"),
            json_optional_string_field(trace, "parentTraceId"),
            json_optional_string_field(trace, "traceState"),
            json_optional_string_field(trace, "traceFlags"),
            attributes,
            resource,
            error,
            payload,
        ],
    )
    .map_err(|error| sqlite_error("Could not write observability trace", error))?;
    Ok(())
}

fn write_observability_span(
    tx: &rusqlite::Transaction<'_>,
    root_dir: &str,
    span: &Value,
) -> napi::Result<()> {
    let attributes = json_payload_field(span, "attributes")?;
    let resource = json_optional_payload_field(span, "resource")?;
    let output = json_optional_payload_field(span, "output")?;
    let error = json_optional_payload_field(span, "error")?;
    let payload = json_payload(span)?;
    tx.execute(
        "insert into observability_spans(
           root_dir, id, trace_id, parent_span_id, name, kind, otel_kind, status,
           recording, sampled, started_at, ended_at, duration_ms, trace_parent,
           trace_state, trace_flags, attributes, resource, output, error, payload
         ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
         on conflict(root_dir, id) do update set
           trace_id = excluded.trace_id,
           parent_span_id = excluded.parent_span_id,
           name = excluded.name,
           kind = excluded.kind,
           otel_kind = excluded.otel_kind,
           status = excluded.status,
           recording = excluded.recording,
           sampled = excluded.sampled,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           duration_ms = excluded.duration_ms,
           trace_parent = excluded.trace_parent,
           trace_state = excluded.trace_state,
           trace_flags = excluded.trace_flags,
           attributes = excluded.attributes,
           resource = excluded.resource,
           output = excluded.output,
           error = excluded.error,
           payload = excluded.payload",
        params![
            root_dir,
            json_string_field(span, "id")?,
            json_string_field(span, "traceId")?,
            json_optional_string_field(span, "parentSpanId"),
            json_string_field(span, "name")?,
            json_string_field(span, "kind")?,
            json_string_field(span, "otelKind")?,
            json_string_field(span, "status")?,
            json_bool_field(span, "recording")? as i64,
            json_bool_field(span, "sampled")? as i64,
            json_string_field(span, "startedAt")?,
            json_optional_string_field(span, "endedAt"),
            json_optional_f64_field(span, "durationMs"),
            json_string_field(span, "traceParent")?,
            json_optional_string_field(span, "traceState"),
            json_string_field(span, "traceFlags")?,
            attributes,
            resource,
            output,
            error,
            payload,
        ],
    )
    .map_err(|error| sqlite_error("Could not write observability span", error))?;
    Ok(())
}

fn write_observability_event(
    tx: &rusqlite::Transaction<'_>,
    root_dir: &str,
    event: &Value,
) -> napi::Result<()> {
    let attributes = json_optional_payload_field(event, "attributes")?;
    let resource = json_optional_payload_field(event, "resource")?;
    let payload = json_payload(event)?;
    tx.execute(
        "insert into observability_events(
           root_dir, id, trace_id, span_id, name, occurred_at, trace_flags, sampled,
           attributes, resource, payload
         ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         on conflict(root_dir, id) do update set
           trace_id = excluded.trace_id,
           span_id = excluded.span_id,
           name = excluded.name,
           occurred_at = excluded.occurred_at,
           trace_flags = excluded.trace_flags,
           sampled = excluded.sampled,
           attributes = excluded.attributes,
           resource = excluded.resource,
           payload = excluded.payload",
        params![
            root_dir,
            json_string_field(event, "id")?,
            json_string_field(event, "traceId")?,
            json_optional_string_field(event, "spanId"),
            json_string_field(event, "name")?,
            json_string_field(event, "occurredAt")?,
            json_optional_string_field(event, "traceFlags"),
            json_optional_bool_field(event, "sampled").map(|value| value as i64),
            attributes,
            resource,
            payload,
        ],
    )
    .map_err(|error| sqlite_error("Could not write observability event", error))?;
    Ok(())
}

fn list_observability_payloads(
    conn: &Connection,
    root_dir: &str,
    table: &str,
    order_expr: &str,
    trace_column: &str,
    trace_id: Option<&str>,
    limit: u32,
) -> napi::Result<Vec<Value>> {
    let limit = i64::from(limit);
    match trace_id {
        Some(trace_id) => {
            let sql = format!(
                "select payload from {table} where root_dir = ?1 and {trace_column} = ?2 order by {order_expr} desc limit ?3"
            );
            let mut statement = conn
                .prepare(&sql)
                .map_err(|error| sqlite_error("Could not prepare observability list", error))?;
            let mut rows = statement
                .query(params![root_dir, trace_id, limit])
                .map_err(|error| sqlite_error("Could not list observability records", error))?;
            collect_observability_payloads(&mut rows)
        }
        None => {
            let sql = format!(
                "select payload from {table} where root_dir = ?1 order by {order_expr} desc limit ?2"
            );
            let mut statement = conn
                .prepare(&sql)
                .map_err(|error| sqlite_error("Could not prepare observability list", error))?;
            let mut rows = statement
                .query(params![root_dir, limit])
                .map_err(|error| sqlite_error("Could not list observability records", error))?;
            collect_observability_payloads(&mut rows)
        }
    }
}

fn collect_observability_payloads(rows: &mut rusqlite::Rows<'_>) -> napi::Result<Vec<Value>> {
    let mut payloads = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| sqlite_error("Could not decode observability row", error))?
    {
        let payload = row
            .get::<_, String>(0)
            .map_err(|error| sqlite_error("Could not decode observability payload", error))?;
        payloads.push(
            serde_json::from_str::<Value>(&payload)
                .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?,
        );
    }
    Ok(payloads)
}

fn root_path(root_dir: &str, file: &str) -> PathBuf {
    Path::new(root_dir).join(file)
}

fn json_object_field<'a>(
    value: &'a Value,
    field: &str,
) -> napi::Result<&'a serde_json::Map<String, Value>> {
    value.get(field).and_then(Value::as_object).ok_or_else(|| {
        napi_error(
            "invalid-engine-payload",
            &format!("Product model projection is missing object field {field}."),
        )
    })
}

fn json_array_field<'a>(
    value: &'a serde_json::Map<String, Value>,
    field: &str,
) -> napi::Result<&'a Vec<Value>> {
    value.get(field).and_then(Value::as_array).ok_or_else(|| {
        napi_error(
            "invalid-engine-payload",
            &format!("Product model projection is missing array field {field}."),
        )
    })
}

fn json_string_field<'a>(value: &'a Value, field: &str) -> napi::Result<&'a str> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        napi_error(
            "invalid-engine-payload",
            &format!("Product model projection is missing string field {field}."),
        )
    })
}

fn json_optional_string_field<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn json_bool_field(value: &Value, field: &str) -> napi::Result<bool> {
    value.get(field).and_then(Value::as_bool).ok_or_else(|| {
        napi_error(
            "invalid-engine-payload",
            &format!("JSON payload is missing boolean field {field}."),
        )
    })
}

fn json_optional_bool_field(value: &Value, field: &str) -> Option<bool> {
    value.get(field).and_then(Value::as_bool)
}

fn json_optional_f64_field(value: &Value, field: &str) -> Option<f64> {
    value.get(field).and_then(Value::as_f64)
}

fn json_payload_field(value: &Value, field: &str) -> napi::Result<String> {
    let payload = value.get(field).ok_or_else(|| {
        napi_error(
            "invalid-engine-payload",
            &format!("JSON payload is missing field {field}."),
        )
    })?;
    json_payload(payload)
}

fn json_optional_payload_field(value: &Value, field: &str) -> napi::Result<Option<String>> {
    match value.get(field) {
        Some(Value::Null) | None => Ok(None),
        Some(payload) => json_payload(payload).map(Some),
    }
}

fn json_payload(value: &Value) -> napi::Result<String> {
    serde_json::to_string(value).map_err(|error| {
        napi_error(
            "invalid-engine-payload",
            &format!("Could not serialize JSON payload: {error}"),
        )
    })
}

fn json_int_field(value: &serde_json::Map<String, Value>, field: &str) -> napi::Result<i64> {
    value.get(field).and_then(Value::as_i64).ok_or_else(|| {
        napi_error(
            "invalid-engine-payload",
            &format!("Product model projection is missing integer field {field}."),
        )
    })
}

fn stable_projection_row_id(parts: &[&str]) -> String {
    let mut hasher = blake3::Hasher::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update(b"\0");
    }
    hasher.finalize().to_hex().to_string()
}

#[allow(clippy::too_many_arguments)]
fn insert_code_node(
    tx: &rusqlite::Transaction<'_>,
    path: &str,
    language: &str,
    content_hash: &str,
    extractor_version: &str,
    indexed_at: &str,
    node: &ExtractedNode,
) -> napi::Result<()> {
    let id = compute_node_id(
        path,
        language,
        &node.kind,
        &node.qualified_name,
        node.range.start_byte,
        &node.disambiguator,
    );
    tx.execute(
        "insert into code_nodes(id, path, language, kind, name, qualified_name, exported, signature,
            start_line, start_column, end_line, end_column, start_byte, end_byte,
            content_hash, extractor_version, indexed_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         on conflict(id) do update set path = excluded.path, language = excluded.language,
            kind = excluded.kind, name = excluded.name, qualified_name = excluded.qualified_name,
            exported = excluded.exported, signature = excluded.signature,
            start_line = excluded.start_line, start_column = excluded.start_column,
            end_line = excluded.end_line, end_column = excluded.end_column,
            start_byte = excluded.start_byte, end_byte = excluded.end_byte,
            content_hash = excluded.content_hash, extractor_version = excluded.extractor_version,
            indexed_at = excluded.indexed_at",
        params![
            id,
            path,
            language,
            node.kind,
            node.name,
            node.qualified_name,
            if node.exported { 1 } else { 0 },
            node.signature,
            node.range.start_line as i64,
            node.range.start_column as i64,
            node.range.end_line as i64,
            node.range.end_column as i64,
            node.range.start_byte as i64,
            node.range.end_byte as i64,
            content_hash,
            extractor_version,
            indexed_at,
        ],
    )
    .map_err(|error| sqlite_error("Could not insert code node", error))?;
    Ok(())
}

fn code_symbol_json(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<serde_json::Value> {
    Ok(json!({
      "id": row.get::<_, String>(offset)?,
      "path": row.get::<_, String>(offset + 1)?,
      "language": row.get::<_, String>(offset + 2)?,
      "kind": row.get::<_, String>(offset + 3)?,
      "name": row.get::<_, String>(offset + 4)?,
      "qualifiedName": row.get::<_, String>(offset + 5)?,
      "exported": row.get::<_, i64>(offset + 6)? != 0,
      "signature": row.get::<_, Option<String>>(offset + 7)?,
      "range": {
        "start": {
          "line": row.get::<_, i64>(offset + 8)?,
          "column": row.get::<_, i64>(offset + 9)?,
          "byte": row.get::<_, i64>(offset + 10)?,
        },
        "end": {
          "line": row.get::<_, i64>(offset + 11)?,
          "column": row.get::<_, i64>(offset + 12)?,
          "byte": row.get::<_, i64>(offset + 13)?,
        },
      },
      "score": null,
    }))
}

fn resolve_exact_code_edges(tx: &rusqlite::Transaction<'_>, root_dir: &str) -> napi::Result<()> {
    let nodes = load_resolver_nodes(tx)?;
    let references = load_resolver_references(tx)?;
    let mut nodes_by_file_name: HashMap<(String, String), Vec<ResolverNode>> = HashMap::new();
    let mut exported_by_file_name: HashMap<(String, String), Vec<ResolverNode>> = HashMap::new();
    let mut nodes_by_name: HashMap<String, Vec<ResolverNode>> = HashMap::new();
    for node in nodes.iter().cloned() {
        nodes_by_file_name
            .entry((node.path.clone(), node.name.clone()))
            .or_default()
            .push(node.clone());
        nodes_by_name
            .entry(node.name.clone())
            .or_default()
            .push(node.clone());
        if node.exported {
            exported_by_file_name
                .entry((node.path.clone(), node.name.clone()))
                .or_default()
                .push(node);
        }
    }
    let imports_by_file_name = references
        .iter()
        .filter(|reference| {
            matches!(
                reference.kind.as_str(),
                "import-named" | "import-default" | "import-namespace" | "import-module"
            )
        })
        .fold(
            HashMap::<(String, String), Vec<ResolverReference>>::new(),
            |mut map, reference| {
                map.entry((reference.path.clone(), reference.name.clone()))
                    .or_default()
                    .push(reference.clone());
                map
            },
        );
    let indexed_paths = nodes
        .iter()
        .map(|node| node.path.clone())
        .collect::<HashSet<_>>();
    let module_resolver = ModuleResolver::new(root_dir, &indexed_paths);

    for reference in references
        .iter()
        .filter(|reference| matches!(reference.kind.as_str(), "call" | "identifier"))
    {
        let Some(source) = nearest_source_node(&nodes, &reference.path, reference.start_byte)
        else {
            continue;
        };
        let target = resolve_reference_target(
            reference,
            &nodes_by_file_name,
            &exported_by_file_name,
            &nodes_by_name,
            &imports_by_file_name,
            &module_resolver,
        );
        let Some(target) = target else { continue };
        if source.id == target.id {
            continue;
        }
        insert_code_edge(tx, &source.id, &target.id, &reference.kind, reference)?;
    }
    Ok(())
}

#[derive(Clone)]
struct ResolverNode {
    id: String,
    path: String,
    name: String,
    exported: bool,
    start_byte: i64,
}

#[derive(Clone)]
struct ResolverReference {
    path: String,
    language: String,
    name: String,
    kind: String,
    source: Option<String>,
    start_line: i64,
    start_column: i64,
    start_byte: i64,
    provenance: String,
}

fn load_resolver_nodes(tx: &rusqlite::Transaction<'_>) -> napi::Result<Vec<ResolverNode>> {
    let mut statement = tx
        .prepare(
            "select id, path, name, exported, start_byte from code_nodes order by path, start_byte",
        )
        .map_err(|error| sqlite_error("Could not prepare graph node resolver", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ResolverNode {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                exported: row.get::<_, i64>(3)? != 0,
                start_byte: row.get(4)?,
            })
        })
        .map_err(|error| sqlite_error("Could not load graph resolver nodes", error))?;
    let mut nodes = Vec::new();
    for row in rows {
        nodes.push(
            row.map_err(|error| sqlite_error("Could not decode graph resolver node", error))?,
        );
    }
    Ok(nodes)
}

fn load_resolver_references(
    tx: &rusqlite::Transaction<'_>,
) -> napi::Result<Vec<ResolverReference>> {
    let mut statement = tx
        .prepare(
            "select path, language, reference_name, reference_kind, source, start_line, start_column, start_byte, provenance
             from unresolved_references order by path, start_byte",
        )
        .map_err(|error| sqlite_error("Could not prepare graph reference resolver", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ResolverReference {
                path: row.get(0)?,
                language: row.get(1)?,
                name: row.get(2)?,
                kind: row.get(3)?,
                source: row.get(4)?,
                start_line: row.get(5)?,
                start_column: row.get(6)?,
                start_byte: row.get(7)?,
                provenance: row.get(8)?,
            })
        })
        .map_err(|error| sqlite_error("Could not load graph resolver references", error))?;
    let mut references = Vec::new();
    for row in rows {
        references.push(
            row.map_err(|error| sqlite_error("Could not decode graph resolver reference", error))?,
        );
    }
    Ok(references)
}

fn nearest_source_node(nodes: &[ResolverNode], path: &str, byte: i64) -> Option<ResolverNode> {
    nodes
        .iter()
        .filter(|node| node.path == path && node.start_byte <= byte)
        .max_by_key(|node| node.start_byte)
        .cloned()
}

fn resolve_reference_target(
    reference: &ResolverReference,
    nodes_by_file_name: &HashMap<(String, String), Vec<ResolverNode>>,
    exported_by_file_name: &HashMap<(String, String), Vec<ResolverNode>>,
    nodes_by_name: &HashMap<String, Vec<ResolverNode>>,
    imports_by_file_name: &HashMap<(String, String), Vec<ResolverReference>>,
    module_resolver: &ModuleResolver,
) -> Option<ResolverNode> {
    if reference.language == "python" && reference.source.is_some() {
        return resolve_python_sourced_reference(reference, exported_by_file_name, module_resolver);
    }
    if let Some(same_file) =
        nodes_by_file_name.get(&(reference.path.clone(), reference.name.clone()))
    {
        if same_file.len() == 1 {
            return same_file.first().cloned();
        }
    }
    if let Some(imports) =
        imports_by_file_name.get(&(reference.path.clone(), reference.name.clone()))
    {
        let mut targets = Vec::new();
        for import in imports {
            let Some(source_path) = import.source.as_deref().and_then(|source| {
                module_resolver.resolve_for_language(&reference.path, source, &import.language)
            }) else {
                continue;
            };
            match import.kind.as_str() {
                "import-named" => targets.extend(
                    exported_by_file_name
                        .get(&(source_path, import.name.clone()))
                        .cloned()
                        .unwrap_or_default(),
                ),
                "import-default" => {
                    let explicit_default = exported_by_file_name
                        .get(&(source_path.clone(), "default".to_string()))
                        .cloned()
                        .unwrap_or_default();
                    if explicit_default.is_empty() {
                        let exported = exported_nodes_for_path(exported_by_file_name, &source_path);
                        if exported.len() == 1 {
                            targets.extend(exported);
                        }
                    } else {
                        targets.extend(explicit_default);
                    }
                }
                _ => {}
            }
        }
        if targets.len() == 1 {
            return targets.first().cloned();
        }
    }
    let project_matches = nodes_by_name.get(&reference.name)?;
    if project_matches.len() == 1 {
        return project_matches.first().cloned();
    }
    None
}

fn resolve_python_sourced_reference(
    reference: &ResolverReference,
    exported_by_file_name: &HashMap<(String, String), Vec<ResolverNode>>,
    module_resolver: &ModuleResolver,
) -> Option<ResolverNode> {
    let source = reference.source.as_deref()?;
    let source_path = module_resolver.resolve_python(&reference.path, source)?;
    let targets = exported_by_file_name
        .get(&(source_path.clone(), reference.name.clone()))
        .cloned()
        .unwrap_or_default();
    if targets.len() == 1 {
        return targets.first().cloned();
    }
    if reference.kind == "import-module" {
        let exported = exported_nodes_for_path(exported_by_file_name, &source_path);
        if exported.len() == 1 {
            return exported.first().cloned();
        }
    }
    None
}

fn exported_nodes_for_path(
    exported_by_file_name: &HashMap<(String, String), Vec<ResolverNode>>,
    path: &str,
) -> Vec<ResolverNode> {
    exported_by_file_name
        .iter()
        .filter(|((file, _), _)| file == path)
        .flat_map(|(_, nodes)| nodes.clone())
        .collect()
}

struct ModuleResolver {
    root_dir: String,
    indexed_paths: HashSet<String>,
    aliases: Vec<TsAlias>,
    workspaces: Vec<WorkspacePackage>,
}

struct TsAlias {
    config_root: String,
    base_dir: String,
    pattern: String,
    targets: Vec<String>,
}

struct WorkspacePackage {
    name: String,
    root: String,
}

impl ModuleResolver {
    fn new(root_dir: &str, indexed_paths: &HashSet<String>) -> Self {
        Self {
            root_dir: root_dir.to_string(),
            indexed_paths: indexed_paths.clone(),
            aliases: read_ts_aliases(root_dir),
            workspaces: read_workspace_packages(root_dir),
        }
    }

    fn resolve_for_language(
        &self,
        from_path: &str,
        source: &str,
        language: &str,
    ) -> Option<String> {
        if language == "python" {
            return self.resolve_python(from_path, source);
        }
        self.resolve(from_path, source)
    }

    fn resolve(&self, from_path: &str, source: &str) -> Option<String> {
        if source.starts_with('.') {
            return resolve_relative_module_path(from_path, source, &self.indexed_paths);
        }
        self.resolve_alias(from_path, source)
            .or_else(|| self.resolve_workspace(source))
    }

    fn resolve_alias(&self, from_path: &str, source: &str) -> Option<String> {
        let mut aliases = self
            .aliases
            .iter()
            .filter(|alias| {
                alias.config_root.is_empty()
                    || from_path == alias.config_root
                    || from_path.starts_with(&format!("{}/", alias.config_root))
            })
            .collect::<Vec<_>>();
        aliases.sort_by_key(|alias| std::cmp::Reverse(alias.config_root.len()));

        for alias in aliases {
            let Some(wildcard) = match_alias_pattern(&alias.pattern, source) else {
                continue;
            };
            for target in alias.targets.iter() {
                let target_path = target.replace('*', &wildcard);
                let base = normalize_relative_path(&Path::new(&alias.base_dir).join(target_path));
                if let Some(resolved) = resolve_candidate_path(&base, &self.indexed_paths) {
                    return Some(resolved);
                }
            }
        }
        None
    }

    fn resolve_workspace(&self, source: &str) -> Option<String> {
        let mut packages = self.workspaces.iter().collect::<Vec<_>>();
        packages.sort_by_key(|package| std::cmp::Reverse(package.name.len()));
        let package = packages.into_iter().find(|package| {
            source == package.name || source.starts_with(&format!("{}/", package.name))
        })?;
        let subpath = if source == package.name {
            ""
        } else {
            &source[package.name.len() + 1..]
        };
        let bases = if subpath.is_empty() {
            vec![
                format!("{}/src/index", package.root),
                format!("{}/index", package.root),
            ]
        } else {
            vec![
                format!("{}/{}", package.root, subpath),
                format!("{}/src/{}", package.root, subpath),
            ]
        };
        bases
            .iter()
            .find_map(|base| resolve_candidate_path(base, &self.indexed_paths))
    }

    fn resolve_python(&self, from_path: &str, source: &str) -> Option<String> {
        if source.starts_with('.') {
            return resolve_python_relative_module_path(from_path, source, &self.indexed_paths);
        }
        self.resolve_python_absolute_module_path(from_path, source)
    }

    fn resolve_python_absolute_module_path(&self, from_path: &str, source: &str) -> Option<String> {
        let module_path = source.replace('.', "/");
        self.python_search_roots(from_path)
            .into_iter()
            .find_map(|root| {
                let base = if root.is_empty() {
                    module_path.clone()
                } else {
                    format!("{root}/{module_path}")
                };
                resolve_python_candidate_path(&base, &self.indexed_paths)
            })
    }

    fn python_search_roots(&self, from_path: &str) -> Vec<String> {
        let mut roots = vec![String::new()];
        let mut current = Path::new(from_path)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        while !current.as_os_str().is_empty() {
            let current_string = normalize_relative_path(&current);
            if self.python_directory_has_init(&current_string) {
                let root = current
                    .parent()
                    .map(normalize_relative_path)
                    .unwrap_or_default();
                roots.push(root);
            }
            current = current.parent().map(Path::to_path_buf).unwrap_or_default();
        }
        roots.sort_by_key(|root| root.len());
        roots.dedup();
        roots
    }

    fn python_directory_has_init(&self, directory: &str) -> bool {
        let init_path = if directory.is_empty() {
            "__init__.py".to_string()
        } else {
            format!("{directory}/__init__.py")
        };
        self.indexed_paths.contains(&init_path)
            || Path::new(&self.root_dir).join(init_path).exists()
    }
}

fn resolve_relative_module_path(
    from_path: &str,
    source: &str,
    indexed_paths: &HashSet<String>,
) -> Option<String> {
    if !source.starts_with('.') {
        return None;
    }
    let base = Path::new(from_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let joined = base.join(source);
    let normalized = normalize_relative_path(&joined);
    let candidates = [
        normalized.clone(),
        format!("{normalized}.ts"),
        format!("{normalized}.tsx"),
        format!("{normalized}.js"),
        format!("{normalized}.jsx"),
        format!("{normalized}/index.ts"),
        format!("{normalized}/index.tsx"),
        format!("{normalized}/index.js"),
        format!("{normalized}/index.jsx"),
    ];
    candidates
        .into_iter()
        .find(|candidate| indexed_paths.contains(candidate))
}

fn resolve_candidate_path(base: &str, indexed_paths: &HashSet<String>) -> Option<String> {
    let candidates = [
        base.to_string(),
        format!("{base}.ts"),
        format!("{base}.tsx"),
        format!("{base}.js"),
        format!("{base}.jsx"),
        format!("{base}/index.ts"),
        format!("{base}/index.tsx"),
        format!("{base}/index.js"),
        format!("{base}/index.jsx"),
    ];
    candidates
        .into_iter()
        .find(|candidate| indexed_paths.contains(candidate))
}

fn resolve_python_relative_module_path(
    from_path: &str,
    source: &str,
    indexed_paths: &HashSet<String>,
) -> Option<String> {
    let level = source
        .chars()
        .take_while(|character| *character == '.')
        .count();
    if level == 0 {
        return None;
    }
    let module = source[level..].replace('.', "/");
    let mut base = Path::new(from_path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    for _ in 1..level {
        base = base.parent().map(Path::to_path_buf).unwrap_or_default();
    }
    let joined = if module.is_empty() {
        base
    } else {
        base.join(module)
    };
    let normalized = normalize_relative_path(&joined);
    resolve_python_candidate_path(&normalized, indexed_paths)
}

fn resolve_python_candidate_path(base: &str, indexed_paths: &HashSet<String>) -> Option<String> {
    let candidates = [format!("{base}.py"), format!("{base}/__init__.py")];
    candidates
        .into_iter()
        .find(|candidate| indexed_paths.contains(candidate))
}

fn normalize_relative_path(path: &Path) -> String {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                parts.pop();
            }
            std::path::Component::Normal(value) => {
                parts.push(value.to_string_lossy().to_string());
            }
            _ => {}
        }
    }
    parts.join("/")
}

fn read_ts_aliases(root_dir: &str) -> Vec<TsAlias> {
    find_config_files(root_dir, |name| {
        name.starts_with("tsconfig") && name.ends_with(".json")
    })
    .iter()
    .flat_map(|file| {
        let config = read_json(root_dir, file);
        let Some(paths) = config
            .get("compilerOptions")
            .and_then(|value| value.get("paths"))
            .and_then(|value| value.as_object())
        else {
            return Vec::new();
        };
        let config_root =
            normalize_relative_path(Path::new(file).parent().unwrap_or_else(|| Path::new("")));
        let normalized_root = if config_root == "." {
            String::new()
        } else {
            config_root
        };
        let base_url = config
            .get("compilerOptions")
            .and_then(|value| value.get("baseUrl"))
            .and_then(|value| value.as_str())
            .unwrap_or(".");
        let base_dir = normalize_relative_path(&Path::new(&normalized_root).join(base_url));

        paths
            .iter()
            .filter_map(|(pattern, value)| {
                let targets = value
                    .as_array()?
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect::<Vec<_>>();
                if targets.is_empty() {
                    return None;
                }
                Some(TsAlias {
                    config_root: normalized_root.clone(),
                    base_dir: base_dir.clone(),
                    pattern: pattern.clone(),
                    targets,
                })
            })
            .collect::<Vec<_>>()
    })
    .collect()
}

fn read_workspace_packages(root_dir: &str) -> Vec<WorkspacePackage> {
    find_config_files(root_dir, |name| name == "package.json")
        .iter()
        .filter_map(|file| {
            let json = read_json(root_dir, file);
            let name = json.get("name").and_then(|value| value.as_str())?;
            let root =
                normalize_relative_path(Path::new(file).parent().unwrap_or_else(|| Path::new("")));
            Some(WorkspacePackage {
                name: name.to_string(),
                root,
            })
        })
        .collect()
}

fn find_config_files(root_dir: &str, matches_name: fn(&str) -> bool) -> Vec<String> {
    let mut output = Vec::new();
    collect_config_files(
        Path::new(root_dir),
        Path::new(""),
        matches_name,
        &mut output,
    );
    output.sort();
    output
}

fn collect_config_files(
    root_dir: &Path,
    relative_dir: &Path,
    matches_name: fn(&str) -> bool,
    output: &mut Vec<String>,
) {
    let absolute_dir = root_dir.join(relative_dir);
    let Ok(entries) = fs::read_dir(absolute_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if matches!(
            name.as_str(),
            "node_modules" | ".git" | ".opencanon" | "dist" | "build" | "coverage"
        ) {
            continue;
        }
        let relative_path = relative_dir.join(&name);
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_config_files(root_dir, &relative_path, matches_name, output);
        } else if file_type.is_file() && matches_name(&name) {
            output.push(normalize_relative_path(&relative_path));
        }
    }
}

fn read_json(root_dir: &str, file: &str) -> serde_json::Value {
    let path = Path::new(root_dir).join(file);
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&strip_json_comments(&text)).ok())
        .unwrap_or(serde_json::Value::Null)
}

fn strip_json_comments(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(char) = chars.next() {
        if in_string {
            output.push(char);
            if escaped {
                escaped = false;
            } else if char == '\\' {
                escaped = true;
            } else if char == '"' {
                in_string = false;
            }
            continue;
        }

        if char == '"' {
            in_string = true;
            output.push(char);
            continue;
        }

        if char == '/' {
            match chars.peek().copied() {
                Some('/') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if next == '\n' {
                            output.push('\n');
                            break;
                        }
                    }
                    continue;
                }
                Some('*') => {
                    chars.next();
                    let mut previous = '\0';
                    for next in chars.by_ref() {
                        if next == '\n' {
                            output.push('\n');
                        }
                        if previous == '*' && next == '/' {
                            break;
                        }
                        previous = next;
                    }
                    continue;
                }
                _ => {}
            }
        }

        output.push(char);
    }

    output
}

fn match_alias_pattern(pattern: &str, source: &str) -> Option<String> {
    if !pattern.contains('*') {
        return (pattern == source).then(String::new);
    }
    let mut parts = pattern.splitn(2, '*');
    let prefix = parts.next().unwrap_or("");
    let suffix = parts.next().unwrap_or("");
    if !source.starts_with(prefix) || !source.ends_with(suffix) {
        return None;
    }
    // prefix and suffix can overlap for a short source (e.g. pattern "ab*ab", source "ab"):
    // both starts_with and ends_with hold, but prefix.len()+suffix.len() > source.len(), so
    // the slice below would have start > end and panic. Reject that case.
    if source.len() < prefix.len() + suffix.len() {
        return None;
    }
    Some(source[prefix.len()..source.len() - suffix.len()].to_string())
}

fn insert_code_edge(
    tx: &rusqlite::Transaction<'_>,
    source_id: &str,
    target_id: &str,
    kind: &str,
    reference: &ResolverReference,
) -> napi::Result<()> {
    let id = compute_edge_id(
        source_id,
        target_id,
        kind,
        &reference.path,
        reference.start_byte,
    );
    tx.execute(
        "insert into code_edges(id, source_id, target_id, kind, provenance, confidence, path, start_line, start_column, start_byte, metadata)
         values (?1, ?2, ?3, ?4, ?5, 'exact', ?6, ?7, ?8, ?9, '{}')
         on conflict(id) do update set source_id = excluded.source_id, target_id = excluded.target_id,
           kind = excluded.kind, provenance = excluded.provenance, confidence = excluded.confidence,
           path = excluded.path, start_line = excluded.start_line, start_column = excluded.start_column,
           start_byte = excluded.start_byte, metadata = excluded.metadata",
        params![id, source_id, target_id, kind, reference.provenance, reference.path, reference.start_line, reference.start_column, reference.start_byte],
    )
    .map_err(|error| sqlite_error("Could not insert code edge", error))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_unresolved_reference(
    tx: &rusqlite::Transaction<'_>,
    path: &str,
    language: &str,
    content_hash: &str,
    extractor_version: &str,
    indexed_at: &str,
    unresolved: &ExtractedUnresolved,
) -> napi::Result<()> {
    let id = compute_unresolved_id(
        path,
        &unresolved.reference_kind,
        &unresolved.reference_name,
        unresolved.source.as_deref(),
        unresolved.range.start_byte,
    );
    tx.execute(
        "insert into unresolved_references(id, from_node_id, path, language, reference_name, reference_kind,
            source, start_line, start_column, end_line, end_column, start_byte, end_byte,
            candidates, provenance, confidence, content_hash, extractor_version, indexed_at)
         values (?1, null, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, '[]', ?13, ?14, ?15, ?16, ?17)
         on conflict(id) do update set path = excluded.path, language = excluded.language,
            reference_name = excluded.reference_name, reference_kind = excluded.reference_kind,
            source = excluded.source, start_line = excluded.start_line, start_column = excluded.start_column,
            end_line = excluded.end_line, end_column = excluded.end_column,
            start_byte = excluded.start_byte, end_byte = excluded.end_byte,
            provenance = excluded.provenance, confidence = excluded.confidence,
            content_hash = excluded.content_hash, extractor_version = excluded.extractor_version,
            indexed_at = excluded.indexed_at",
        params![
            id,
            path,
            language,
            unresolved.reference_name,
            unresolved.reference_kind,
            unresolved.source,
            unresolved.range.start_line as i64,
            unresolved.range.start_column as i64,
            unresolved.range.end_line as i64,
            unresolved.range.end_column as i64,
            unresolved.range.start_byte as i64,
            unresolved.range.end_byte as i64,
            unresolved.provenance,
            unresolved.confidence,
            content_hash,
            extractor_version,
            indexed_at,
        ],
    )
    .map_err(|error| sqlite_error("Could not insert unresolved reference", error))?;
    Ok(())
}

fn fts_match_query(value: &str) -> String {
    let mut tokens = Vec::new();
    for raw in value.split(|character: char| !character.is_alphanumeric() && character != '_') {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }
        tokens.push(format!("{token}*"));
    }
    if tokens.is_empty() {
        return String::new();
    }
    tokens.join(" ")
}
