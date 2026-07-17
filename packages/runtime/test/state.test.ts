import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createPaths } from "@opencanon/core";
import { createProjectStore, projectRuntimeStatePath, StableRuntimeNamespace } from "@opencanon/runtime";
import { createEngine } from "@opencanon/engine";
import { admittedJobs, assignedJobEvent, assignedProjectPublication, assignedProtocolEvent, emptyProtocolEventWindow, emptyPruneResult, initialProjectPublication, fakeInferenceEngineBinding } from "./engine-binding-test-support.ts";

test("runtime store can use an isolated state path", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-store-"));
  const statePath = path.join(rootDir, "isolated", "state.sqlite");
  let openedStatePath = "";
  const engine = createEngine({
    ...fakeInferenceEngineBinding(),
    versionJson: () => JSON.stringify({ packageVersion: "0.1.0", engineVersion: "0.1.0", napiVersion: "3.9.0", schemaVersion: 1 }),
    openProjectJson: (requestJson: string) => {
      openedStatePath = (JSON.parse(requestJson) as { statePath: string }).statePath;
      return {
        statusJson: () =>
          JSON.stringify({
            rootDir,
            statePath: openedStatePath,
            schemaVersion: 1,
            migrationsApplied: [1],
            refresh: { status: "stale", mode: "manual", bufferedEvents: 0, reason: "File watching is not running; manual refresh is required." },
          }),
        scanAndDiffJson: () =>
          JSON.stringify({
            statePath: openedStatePath,
            schemaVersion: 1,
            inventoryHash: "inventory",
            files: [],
            changedFiles: [],
            unchangedFiles: [],
            deletedFiles: [],
            staleFiles: 0,
          }),
        extractFactsJson: () => JSON.stringify({ files: [], diagnostics: [] }),
        buildRepoGraphJson: () => JSON.stringify({ graph: { rootDir, graphHash: "graph", files: [] } }),
        indexCodeGraphJson: () =>
          JSON.stringify({ generation: "test", indexed: [], deleted: [], diagnostics: [], parserVersion: "oxc-0.128.0", extractorVersion: "oxc-graph-1" }),
        searchSymbolsJson: () => JSON.stringify({ symbols: [] }),
        searchReferencesJson: () => JSON.stringify({ references: [] }),
        searchGraphEdgesJson: () => JSON.stringify({ edges: [] }),
        readProductModelProjectionJson: () => JSON.stringify({ projection: null }),
        readProjectPublicationJson: initialProjectPublication,
        publishProjectStateJson: assignedProjectPublication,
        writeSemanticIndexJson: () => undefined,
        writeSemanticIndexDeltaJson: () => undefined,
        readSemanticIndexStatusJson: () => JSON.stringify({ index: null }),
        listSemanticChunksJson: () => JSON.stringify({ index: null, chunks: [] }),
        searchSemanticIndexJson: () => JSON.stringify({ index: null, results: [] }),
        startWatcherJson: () => JSON.stringify({ running: false, debounceMs: 250, bufferCapacity: 128 }),
        drainWatcherEventsJson: () => JSON.stringify([]),
        stopWatcher: () => undefined,
        writeEventJson: () => undefined,
        listEventsJson: () => JSON.stringify([]),
        appendProtocolEventJson: (requestJson: string) => assignedProtocolEvent(requestJson),
        listProtocolEventsJson: () => emptyProtocolEventWindow(),
        writeJobJson: () => undefined,
        readJobJson: () => JSON.stringify({ job: null }),
        listJobsJson: () => JSON.stringify([]),
        admitJobsJson: (requestJson: string) => admittedJobs(requestJson),
        pruneJobsJson: () => emptyPruneResult(),
        appendJobEventJson: assignedJobEvent,
        listJobEventsJson: () => JSON.stringify([]),
        writeObservabilityRecordsJson: () => undefined,
        listObservabilityRecordsJson: () => JSON.stringify({ traces: [], spans: [], events: [] }),
        close: () => undefined,
      };
    },
  });

  try {
    const store = createProjectStore({ rootDir, paths: createPaths(rootDir), engine: engine, statePath });
    assert.equal(store.statePath, statePath);
    assert.equal(openedStatePath, statePath);
    assert.notEqual(store.statePath, projectRuntimeStatePath(rootDir, StableRuntimeNamespace));
    store.close();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
