use std::collections::{BTreeSet, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{Receiver, RecvTimeoutError},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use globset::{Glob, GlobSet};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use notify::{Event, EventKind};

use crate::contracts::{ResolvedProjectSettings, WatcherEventBatch};
use crate::json::napi_error;
use crate::state::{mark_watch_state_stale, timestamp};

pub(crate) type WatcherCallback = Arc<ThreadsafeFunction<String>>;
pub(crate) type WatcherQueue = Arc<Mutex<VecDeque<WatcherEventBatch>>>;

pub(crate) struct NativeWatcher {
    pub(crate) watcher: Option<notify::RecommendedWatcher>,
    pub(crate) stop: Arc<AtomicBool>,
    pub(crate) thread: Option<JoinHandle<()>>,
}

impl NativeWatcher {
    pub(crate) fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.watcher.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for NativeWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

pub(crate) struct WatcherPathFilter {
    ignore: GlobSet,
}

pub(crate) struct WatcherThreadInput {
    pub(crate) root_dir: PathBuf,
    pub(crate) state_path: String,
    pub(crate) filter: WatcherPathFilter,
    pub(crate) queue: WatcherQueue,
    pub(crate) callback: WatcherCallback,
    pub(crate) stop: Arc<AtomicBool>,
    pub(crate) debounce: Duration,
    pub(crate) buffer_capacity: usize,
}

pub(crate) fn run_watcher_thread(input: WatcherThreadInput, rx: Receiver<notify::Result<Event>>) {
    let mut pending_paths = BTreeSet::new();
    let mut pending_reason: Option<String> = None;
    let mut deadline: Option<Instant> = None;

    loop {
        if input.stop.load(Ordering::SeqCst) && deadline.is_none() {
            break;
        }
        let timeout = deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|| Duration::from_millis(100));
        match rx.recv_timeout(timeout) {
            Ok(Ok(event)) => {
                for path in watcher_event_paths(&input.root_dir, &input.filter, event) {
                    pending_paths.insert(path);
                }
                if !pending_paths.is_empty() {
                    deadline = Some(Instant::now() + input.debounce);
                }
            }
            Ok(Err(error)) => {
                pending_reason = Some(format!("Watcher backend reported an error: {error}"));
                deadline = Some(Instant::now() + input.debounce);
            }
            Err(RecvTimeoutError::Timeout) => {
                if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                    emit_watcher_batch(&input, &mut pending_paths, &mut pending_reason);
                    deadline = None;
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                emit_watcher_batch(&input, &mut pending_paths, &mut pending_reason);
                break;
            }
        }
    }
}

fn emit_watcher_batch(
    input: &WatcherThreadInput,
    pending_paths: &mut BTreeSet<String>,
    pending_reason: &mut Option<String>,
) {
    if pending_paths.is_empty() && pending_reason.is_none() {
        return;
    }
    let mut batch = WatcherEventBatch {
        root_dir: input.root_dir.to_string_lossy().to_string(),
        paths: pending_paths.iter().cloned().collect(),
        stale: pending_reason.is_some(),
        reason: pending_reason.take(),
        timestamp: timestamp(),
    };
    pending_paths.clear();

    if let Ok(mut queue) = input.queue.lock() {
        if queue.len() >= input.buffer_capacity {
            queue.pop_front();
            batch.stale = true;
            batch.reason =
                Some("Watcher event buffer overflow; full reindex required.".to_string());
        }
        queue.push_back(batch.clone());
    } else {
        batch.stale = true;
        batch.reason =
            Some("Watcher event buffer lock is poisoned; full reindex required.".to_string());
    }
    if batch.stale {
        mark_watch_state_stale(&input.state_path, &batch.root_dir, batch.reason.as_deref());
    }
    if let Ok(payload) = serde_json::to_string(&batch) {
        let status = input
            .callback
            .call(Ok(payload), ThreadsafeFunctionCallMode::NonBlocking);
        if status != napi::Status::Ok {
            mark_watch_state_stale(
                &input.state_path,
                &batch.root_dir,
                Some("Watcher callback could not accept an event batch."),
            );
        }
    }
}

pub(crate) fn watcher_event_paths(
    root_dir: &Path,
    filter: &WatcherPathFilter,
    event: Event,
) -> Vec<String> {
    if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
        return Vec::new();
    }
    event
        .paths
        .iter()
        .filter_map(|path| normalize_watcher_path(root_dir, filter, path))
        .collect()
}

pub(crate) fn normalize_watcher_path(
    root_dir: &Path,
    filter: &WatcherPathFilter,
    event_path: &Path,
) -> Option<String> {
    let absolute = if event_path.is_absolute() {
        event_path.to_path_buf()
    } else {
        root_dir.join(event_path)
    };
    let relative = absolute.strip_prefix(root_dir).ok()?;
    let slash_path = path_to_slash(relative)?;
    if watcher_path_is_ignored(&slash_path, filter) {
        return None;
    }
    Some(slash_path)
}

fn path_to_slash(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().to_string()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn watcher_path_is_ignored(path: &str, filter: &WatcherPathFilter) -> bool {
    if path.split('/').any(|part| {
        matches!(
            part,
            ".git" | ".opencanon" | "node_modules" | "dist" | "build" | "coverage"
        )
    }) {
        return true;
    }
    filter.ignore.is_match(path)
}

pub(crate) fn build_watcher_filter(
    settings: &ResolvedProjectSettings,
) -> napi::Result<WatcherPathFilter> {
    let mut builder = GlobSet::builder();
    for pattern in &settings.ignore {
        builder.add(Glob::new(pattern).map_err(|error| {
            napi_error(
                "invalid-engine-payload",
                &format!("Invalid watcher ignore glob {pattern}: {error}"),
            )
        })?);
    }
    let ignore = builder.build().map_err(|error| {
        napi_error(
            "invalid-engine-payload",
            &format!("Could not compile watcher ignore globs: {error}"),
        )
    })?;
    Ok(WatcherPathFilter { ignore })
}
