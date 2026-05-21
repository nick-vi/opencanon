import {
  formatOpenCanonDiagnostics,
  loadProjectContext,
  readValidatorGraphSourceSignature,
  type ContextPaths,
} from "@opencanon/core";
import type { DaemonSnapshot } from "./snapshot.ts";
import { daemonSnapshotFailure } from "./snapshot.ts";
import { StreamEventType, type EventBroadcaster } from "./server-events.ts";

export type ValidatorGraphRuntime = {
  refreshIfChanged(current: DaemonSnapshot): Promise<DaemonSnapshot>;
  recordCurrentSourceSignature(): void;
};

export function createValidatorGraphRuntime(input: {
  rootDir: string;
  paths: ContextPaths;
  events: EventBroadcaster;
  initialDependencyFiles?: string[];
  rebuildAndPublish(summary: string): Promise<DaemonSnapshot>;
  isStopped(): boolean;
}): ValidatorGraphRuntime {
  let dependencyFiles = input.initialDependencyFiles;
  let sourceSignature = readCurrentSourceSignature(input, dependencyFiles);
  let refreshInFlight: Promise<DaemonSnapshot> | undefined;

  async function refreshIfChanged(current: DaemonSnapshot): Promise<DaemonSnapshot> {
    if (input.isStopped()) return current;
    const nextSignature = readValidatorGraphSourceSignature(input.rootDir, input.paths, dependencyFiles);
    if (nextSignature.diagnostics.length > 0) {
      broadcastValidatorGraphDiagnostics(input.events, nextSignature.diagnostics);
      return current;
    }
    if (nextSignature.signature === sourceSignature) return current;
    refreshInFlight ??= refreshSnapshot(current, nextSignature.signature).finally(() => {
      refreshInFlight = undefined;
    });
    return await refreshInFlight;
  }

  async function refreshSnapshot(current: DaemonSnapshot, nextSignature: string): Promise<DaemonSnapshot> {
    try {
      const project = await loadProjectContext(input.rootDir);
      dependencyFiles = project.validatorGraph.dependencyFiles;
      sourceSignature = readCurrentSourceSignature(input, dependencyFiles);
      if (project.validatorGraph.hash === current.health.validatorGraph?.hash) return current;
      return await input.rebuildAndPublish(`Validator graph changed: ${project.validatorGraph.validatorCount} validators loaded.`);
    } catch (error) {
      input.events.broadcast({
        type: StreamEventType.Indexing,
        timestamp: new Date().toISOString(),
        summary: formatOpenCanonDiagnostics(daemonSnapshotFailure(error).diagnostics),
      });
      return current;
    }
  }

  function recordCurrentSourceSignature(): void {
    sourceSignature = readCurrentSourceSignature(input, dependencyFiles);
  }

  return { refreshIfChanged, recordCurrentSourceSignature };
}

function readCurrentSourceSignature(input: { rootDir: string; paths: ContextPaths; events: EventBroadcaster }, dependencyFiles: string[] | undefined): string {
  const result = readValidatorGraphSourceSignature(input.rootDir, input.paths, dependencyFiles);
  if (result.diagnostics.length > 0) broadcastValidatorGraphDiagnostics(input.events, result.diagnostics);
  return result.signature;
}

function broadcastValidatorGraphDiagnostics(events: EventBroadcaster, diagnostics: string[]): void {
  events.broadcast({
    type: StreamEventType.Indexing,
    timestamp: new Date().toISOString(),
    summary: diagnostics.join("\n"),
  });
}
