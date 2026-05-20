use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicBool, mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use napi_derive::napi;
use notify::{Event, RecursiveMode, Watcher};
use rusqlite::{params, Connection};
use serde_json::json;

use crate::code_graph::{
    compute_edge_id, compute_node_id, compute_unresolved_id, CodeExtractionInput, CodeExtractor,
    ExtractedNode, ExtractedUnresolved, OxcExtractor,
};
use crate::constants::{
    EXTRACTOR_VERSION, PARSER_VERSION, WATCHER_DEFAULT_BUFFER_CAPACITY,
    WATCHER_DEFAULT_DEBOUNCE_MS, WATCHER_MAX_BUFFER_CAPACITY, WATCHER_MAX_DEBOUNCE_MS,
    WATCHER_MIN_DEBOUNCE_MS,
};
use crate::contracts::{
    BuildRepoGraphRequest, ExtractFactsRequest, FactDiagnostic, IndexCodeGraphRequest,
    ListEventsRequest, OpenProjectRequest, ResolvedProjectSettings, ScanAndDiffRequest,
    SearchGraphEdgesRequest, SearchReferencesRequest, SearchSymbolsRequest, StartWatcherRequest,
    WatcherStartResult, WatcherStatus, WriteEventRequest,
};
use crate::facts::{package_nodes, scan_file_facts};
use crate::json::{decode, encode, napi_error, notify_error, sqlite_error};
use crate::state::{
    migrate_state, read_existing_file_hashes, read_watch_state_status, schema_version, timestamp,
};
use crate::watcher::{
    build_watcher_filter, run_watcher_worker, NativeWatcher, WatcherCallback, WatcherQueue,
    WatcherWorkerInput,
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
}

#[napi]
impl EngineProjectHandle {
    #[napi(js_name = "statusJson")]
    pub fn status_json(&self) -> napi::Result<String> {
        let watcher = self.watcher_status()?;
        encode(&json!({
          "rootDir": self.root_dir,
          "statePath": self.state_path,
          "schemaVersion": schema_version(),
          "migrationsApplied": self.migrations_applied,
          "watcher": watcher,
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
            let text = match fs::read_to_string(root_path(&self.root_dir, &file.path)) {
                Ok(text) => text,
                Err(error) => {
                    diagnostics.push(FactDiagnostic {
                        code: "read-failed".to_string(),
                        message: format!("Could not read {}: {error}", file.path),
                        severity: "error".to_string(),
                    });
                    continue;
                }
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
        let extractor = OxcExtractor;

        let mut prepared = Vec::with_capacity(request.files.len());
        let mut diagnostics = Vec::new();
        for file in request.files.iter() {
            let text = match fs::read_to_string(root_path(&self.root_dir, &file.path)) {
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
            };
            let result = extractor.extract(CodeExtractionInput {
                path: &file.path,
                language: &file.language,
                text: &text,
                content_hash: &file.content_hash,
                extractor_version: &extractor_version,
            });
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
        let stop_for_worker = stop.clone();
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = notify::recommended_watcher(tx)
            .map_err(|error| notify_error("Could not create engine watcher", error))?;
        watcher
            .watch(&root_dir, RecursiveMode::Recursive)
            .map_err(|error| notify_error("Could not watch project root", error))?;
        let worker = thread::spawn(move || {
            run_watcher_worker(
                WatcherWorkerInput {
                    root_dir,
                    state_path,
                    filter,
                    queue,
                    callback,
                    stop: stop_for_worker,
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
            worker: Some(worker),
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
        let conn = Connection::open(&request.state_path)
            .map_err(|error| sqlite_error("Could not open project state database", error))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| sqlite_error("Could not enable SQLite WAL mode", error))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|error| sqlite_error("Could not set SQLite synchronous mode", error))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|error| sqlite_error("Could not set SQLite busy timeout", error))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| sqlite_error("Could not enable SQLite foreign keys", error))?;
        let migrations_applied = migrate_state(&conn)?;
        conn.execute(
            "insert into meta(key, value) values (?1, ?2)
             on conflict(key) do update set value = excluded.value",
            params![
                "projectSettings",
                serde_json::to_string(&request.settings).unwrap_or_default()
            ],
        )
        .map_err(|error| sqlite_error("Could not persist project settings", error))?;

        Ok(Self {
            root_dir: request.root_dir,
            state_path: request.state_path,
            settings: request.settings,
            migrations_applied,
            conn: Mutex::new(conn),
            watcher_queue: Arc::new(Mutex::new(VecDeque::new())),
            watcher: Mutex::new(None),
        })
    }

    fn watcher_status(&self) -> napi::Result<WatcherStatus> {
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
        Ok(WatcherStatus {
            running,
            buffered_events,
            stale: state.0,
            reason: state.1,
        })
    }
}

fn root_path(root_dir: &str, file: &str) -> PathBuf {
    Path::new(root_dir).join(file)
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
                "import-named" | "import-default" | "import-namespace"
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
    name: String,
    kind: String,
    source: Option<String>,
    start_line: i64,
    start_column: i64,
    start_byte: i64,
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
            "select path, reference_name, reference_kind, source, start_line, start_column, start_byte
             from unresolved_references order by path, start_byte",
        )
        .map_err(|error| sqlite_error("Could not prepare graph reference resolver", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ResolverReference {
                path: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                source: row.get(3)?,
                start_line: row.get(4)?,
                start_column: row.get(5)?,
                start_byte: row.get(6)?,
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
            let Some(source_path) = import
                .source
                .as_deref()
                .and_then(|source| module_resolver.resolve(&reference.path, source))
            else {
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
            indexed_paths: indexed_paths.clone(),
            aliases: read_ts_aliases(root_dir),
            workspaces: read_workspace_packages(root_dir),
        }
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
         values (?1, ?2, ?3, ?4, 'oxc', 'exact', ?5, ?6, ?7, ?8, '{}')
         on conflict(id) do update set source_id = excluded.source_id, target_id = excluded.target_id,
           kind = excluded.kind, provenance = excluded.provenance, confidence = excluded.confidence,
           path = excluded.path, start_line = excluded.start_line, start_column = excluded.start_column,
           start_byte = excluded.start_byte, metadata = excluded.metadata",
        params![id, source_id, target_id, kind, reference.path, reference.start_line, reference.start_column, reference.start_byte],
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
