use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicBool, mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use napi_derive::napi;
use notify::{Event, RecursiveMode, Watcher};
use opencanon_inference::{Embedder, EmbedderConfig, Generator, GeneratorConfig};
use rusqlite::{params, Connection};
use serde_json::json;

use crate::constants::{
    PARSER_VERSION, WATCHER_DEFAULT_BUFFER_CAPACITY, WATCHER_DEFAULT_DEBOUNCE_MS,
    WATCHER_MAX_BUFFER_CAPACITY, WATCHER_MAX_DEBOUNCE_MS, WATCHER_MIN_DEBOUNCE_MS,
};
use crate::contracts::{
    BuildRepoGraphRequest, EmbedSemanticTextsRequest, ExtractFactsRequest, FactDiagnostic,
    GenerateTextRequest, ListEventsRequest, ListObservabilityRecordsRequest, OpenProjectRequest,
    ProjectRefreshStatus, ResolvedProjectSettings, ScanAndDiffRequest, StartWatcherRequest,
    WatcherStartResult, WriteEventRequest, WriteObservabilityRecordsRequest,
};
use crate::facts::{package_nodes, scan_file_facts};
use crate::json::{decode, encode, napi_error, notify_error, sqlite_error};
use crate::observability::{ObservationBatch, ObservationSink};
use crate::state::{read_existing_file_hashes, read_watch_state_status, schema_version, timestamp};
use crate::watcher::{
    build_watcher_filter, run_watcher_thread, NativeWatcher, WatcherCallback, WatcherQueue,
    WatcherThreadInput,
};

mod code_graph_resolver;
mod code_graph_store;
mod connection;
mod job_store;
mod json_fields;
mod observability_store;
mod product_model_store;
mod semantic_delta_store;
mod semantic_store;

use connection::open_project_connection;
use json_fields::root_path;
use observability_store::{list_observability_payloads, SqliteObservationSink};
use semantic_store::inference_error;

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

fn canon_event_links(event: &serde_json::Value) -> napi::Result<Vec<(&'static str, String)>> {
    let mut links = Vec::new();
    for (field, kind) in [
        ("changeIds", "change"),
        ("taskIds", "task"),
        ("checkIds", "check"),
    ] {
        let Some(values) = event.get(field).and_then(serde_json::Value::as_array) else {
            continue;
        };
        for value in values {
            let value = value
                .as_str()
                .filter(|item| !item.trim().is_empty())
                .ok_or_else(|| {
                    napi_error(
                        "invalid-engine-payload",
                        &format!("Canon event {field} must contain non-empty strings."),
                    )
                })?;
            links.push((kind, value.to_string()));
        }
    }
    Ok(links)
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
        code_graph_store::index_code_graph_json(self, request)
    }

    #[napi(js_name = "searchSymbolsJson")]
    pub fn search_symbols_json(&self, request: String) -> napi::Result<String> {
        code_graph_store::search_symbols_json(self, request)
    }

    #[napi(js_name = "searchReferencesJson")]
    pub fn search_references_json(&self, request: String) -> napi::Result<String> {
        code_graph_store::search_references_json(self, request)
    }

    #[napi(js_name = "searchGraphEdgesJson")]
    pub fn search_graph_edges_json(&self, request: String) -> napi::Result<String> {
        code_graph_store::search_graph_edges_json(self, request)
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
        let links = canon_event_links(&request.event)?;
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        let transaction = conn
            .transaction()
            .map_err(|error| sqlite_error("Could not start Canon event transaction", error))?;
        transaction.execute(
            "insert into canon_events(id, type, timestamp, payload) values (?1, ?2, ?3, ?4)
             on conflict(id) do update set type = excluded.type, timestamp = excluded.timestamp, payload = excluded.payload",
            params![id, event_type, timestamp, payload],
        )
        .map_err(|error| sqlite_error("Could not write canon event", error))?;
        transaction
            .execute(
                "delete from canon_event_links where event_id = ?1",
                params![id],
            )
            .map_err(|error| sqlite_error("Could not replace Canon event links", error))?;
        for (kind, value) in links {
            transaction
                .execute(
                    "insert into canon_event_links(event_id, kind, value) values (?1, ?2, ?3)",
                    params![id, kind, value],
                )
                .map_err(|error| sqlite_error("Could not write Canon event link", error))?;
        }
        transaction
            .commit()
            .map_err(|error| sqlite_error("Could not commit Canon event", error))?;
        Ok(())
    }

    #[napi(js_name = "listEventsJson")]
    pub fn list_events_json(&self, request: String) -> napi::Result<String> {
        let request: ListEventsRequest = decode(&request)?;
        let (change_id, task_id, check_id, limit) = match request.mode.as_str() {
            "recent" => (
                request.change_id,
                request.task_id,
                request.check_id,
                i64::from(
                    request
                        .limit
                        .ok_or_else(|| {
                            napi_error(
                                "invalid-engine-payload",
                                "Recent Canon event queries require limit.",
                            )
                        })?
                        .clamp(1, 500),
                ),
            ),
            "change-history" => {
                let change_id = request
                    .change_id
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        napi_error(
                            "invalid-engine-payload",
                            "Complete Canon history queries require changeId.",
                        )
                    })?;
                (Some(change_id), None, None, i64::MAX)
            }
            _ => {
                return Err(napi_error(
                    "invalid-engine-payload",
                    "Canon event query mode must be recent or change-history.",
                ));
            }
        };
        let conn = self
            .conn
            .lock()
            .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
        let mut statement = conn
            .prepare(
                "select event.payload
                 from canon_events event
                 where (?1 is null or exists (
                   select 1 from canon_event_links link where link.event_id = event.id and link.kind = 'change' and link.value = ?1
                 ))
                 and (?2 is null or exists (
                   select 1 from canon_event_links link where link.event_id = event.id and link.kind = 'task' and link.value = ?2
                 ))
                 and (?3 is null or exists (
                   select 1 from canon_event_links link where link.event_id = event.id and link.kind = 'check' and link.value = ?3
                 ))
                 order by event.timestamp desc, event.id desc
                 limit ?4",
            )
            .map_err(|error| sqlite_error("Could not prepare canon event list", error))?;
        let rows = statement
            .query_map(params![change_id, task_id, check_id, limit], |row| {
                row.get::<_, String>(0)
            })
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

    #[napi(js_name = "writeJobJson")]
    pub fn write_job_json(&self, request: String) -> napi::Result<()> {
        job_store::write_job_json(self, request)
    }

    #[napi(js_name = "readJobJson")]
    pub fn read_job_json(&self, request: String) -> napi::Result<String> {
        job_store::read_job_json(self, request)
    }

    #[napi(js_name = "listJobsJson")]
    pub fn list_jobs_json(&self, request: String) -> napi::Result<String> {
        job_store::list_jobs_json(self, request)
    }

    #[napi(js_name = "admitJobsJson")]
    pub fn admit_jobs_json(&self, request: String) -> napi::Result<String> {
        job_store::admit_jobs_json(self, request)
    }

    #[napi(js_name = "pruneJobsJson")]
    pub fn prune_jobs_json(&self, request: String) -> napi::Result<String> {
        job_store::prune_jobs_json(self, request)
    }

    #[napi(js_name = "appendJobEventJson")]
    pub fn append_job_event_json(&self, request: String) -> napi::Result<()> {
        job_store::append_job_event_json(self, request)
    }

    #[napi(js_name = "listJobEventsJson")]
    pub fn list_job_events_json(&self, request: String) -> napi::Result<String> {
        job_store::list_job_events_json(self, request)
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
        semantic_store::write_knowledge_index_json(self, request)
    }

    #[napi(js_name = "writeSemanticIndexDeltaJson")]
    pub fn write_semantic_index_delta_json(&self, request: String) -> napi::Result<()> {
        semantic_delta_store::write_knowledge_index_delta_json(self, request)
    }

    #[napi(js_name = "readSemanticIndexStatusJson")]
    pub fn read_semantic_index_status_json(&self, request: String) -> napi::Result<String> {
        semantic_store::read_knowledge_index_status_json(self, request)
    }

    #[napi(js_name = "listSemanticChunksJson")]
    pub fn list_semantic_chunks_json(&self, request: String) -> napi::Result<String> {
        semantic_store::list_knowledge_chunks_json(self, request)
    }

    #[napi(js_name = "searchSemanticIndexJson")]
    pub fn search_semantic_index_json(&self, request: String) -> napi::Result<String> {
        semantic_store::search_knowledge_index_json(self, request)
    }

    #[napi(js_name = "embedSemanticTextsJson")]
    pub fn embed_semantic_texts_json(&self, request: String) -> napi::Result<String> {
        semantic_store::embed_semantic_texts_json(self, request)
    }

    #[napi(js_name = "generateTextJson")]
    pub fn generate_text_json(&self, request: String) -> napi::Result<String> {
        semantic_store::generate_text_json(self, request)
    }

    #[napi(js_name = "writeProductModelProjectionJson")]
    pub fn write_product_model_projection_json(&self, request: String) -> napi::Result<()> {
        product_model_store::write_product_model_projection_json(self, request)
    }

    #[napi(js_name = "readProductModelProjectionJson")]
    pub fn read_product_model_projection_json(&self) -> napi::Result<String> {
        product_model_store::read_product_model_projection_json(self)
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
