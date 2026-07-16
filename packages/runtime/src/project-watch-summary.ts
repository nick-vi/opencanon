import type { WatcherEventBatch } from "@opencanon/core";

export function watcherBatchSummary(batch: WatcherEventBatch): string | undefined {
  if (batch.stale) return batch.reason ?? "Engine watcher requested a full reindex.";
  if (batch.paths.length === 0) return undefined;
  return batch.paths.length === 1 ? `Indexed changed file ${batch.paths[0]}.` : `Indexed ${batch.paths.length} changed files.`;
}

export function knowledgeWatchSummary(paths: string[]): string {
  if (paths.length === 0) return "Project Knowledge source changed; refreshing index.";
  return paths.length === 1 ? `Project Knowledge source changed: ${paths[0]}.` : `Project Knowledge source changed in ${paths.length} files.`;
}
