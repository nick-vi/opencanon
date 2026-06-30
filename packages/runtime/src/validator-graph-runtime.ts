import {
  formatOpenCanonDiagnostics,
  getOpenCanonErrorDiagnostics,
  loadProjectContext,
  readValidatorGraphSourceSignature,
  type ContextPaths,
} from "@opencanon/core";
import type { RuntimeSnapshot } from "./snapshot.ts";
import { runtimeSnapshotFailure } from "./snapshot.ts";
import { indexingEvent, streamErrorEvent, type EventBroadcaster } from "./server-events.ts";

export type ValidatorGraphRuntime = {
  refreshIfChanged(current: RuntimeSnapshot): Promise<RuntimeSnapshot>;
  recordCurrentSourceSignature(): void;
};

export function createValidatorGraphRuntime(input: {
  rootDir: string;
  paths: () => ContextPaths;
  events: EventBroadcaster;
  initialDependencyFiles?: string[];
  rebuildAndPublish(summary: string): Promise<RuntimeSnapshot>;
  isStopped(): boolean;
}): ValidatorGraphRuntime {
  let dependencyFiles = input.initialDependencyFiles;
  let sourceSignature = readCurrentSourceSignature(input, dependencyFiles);
  let refreshInFlight: Promise<RuntimeSnapshot> | undefined;

  async function refreshIfChanged(current: RuntimeSnapshot): Promise<RuntimeSnapshot> {
    if (input.isStopped()) return current;
    const nextSignature = readValidatorGraphSourceSignature(input.rootDir, input.paths(), dependencyFiles);
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

  async function refreshSnapshot(current: RuntimeSnapshot, _nextSignature: string): Promise<RuntimeSnapshot> {
    try {
      const project = await loadProjectContext(input.rootDir);
      dependencyFiles = project.validatorGraph.dependencyFiles;
      sourceSignature = readCurrentSourceSignature(input, dependencyFiles);
      if (project.validatorGraph.hash === current.health.validatorGraph?.hash) return current;
      return await input.rebuildAndPublish(`Validator graph changed: ${project.validatorGraph.validatorCount} validators loaded.`);
    } catch (error) {
      input.events.broadcast(streamErrorEvent(formatOpenCanonDiagnostics(getOpenCanonErrorDiagnostics(runtimeSnapshotFailure(error).error))));
      return current;
    }
  }

  function recordCurrentSourceSignature(): void {
    sourceSignature = readCurrentSourceSignature(input, dependencyFiles);
  }

  return { refreshIfChanged, recordCurrentSourceSignature };
}

function readCurrentSourceSignature(input: { rootDir: string; paths: () => ContextPaths; events: EventBroadcaster }, dependencyFiles: string[] | undefined): string {
  const result = readValidatorGraphSourceSignature(input.rootDir, input.paths(), dependencyFiles);
  if (result.diagnostics.length > 0) broadcastValidatorGraphDiagnostics(input.events, result.diagnostics);
  return result.signature;
}

function broadcastValidatorGraphDiagnostics(events: EventBroadcaster, diagnostics: string[]): void {
  events.broadcast(
    indexingEvent(diagnostics.join("\n"), {
      phase: "validator-graph",
      label: "Checking validator graph",
      indeterminate: true,
    }),
  );
}
