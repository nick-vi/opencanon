import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createPaths } from "@opencanon/core";
import { createDaemonStore } from "@opencanon/daemon";
import { createEngine } from "@opencanon/engine";

test("daemon store can use an isolated state path", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-store-"));
  const statePath = path.join(rootDir, "isolated", "state.sqlite");
  let openedStatePath = "";
  const engine = createEngine({
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
            watcher: { running: false, bufferedEvents: 0, stale: false },
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
          JSON.stringify({ indexed: [], deleted: [], diagnostics: [], parserVersion: "oxc-0.128.0", extractorVersion: "oxc-graph-1" }),
        searchSymbolsJson: () => JSON.stringify({ symbols: [] }),
        searchReferencesJson: () => JSON.stringify({ references: [] }),
        startWatcherJson: () => JSON.stringify({ running: false, debounceMs: 250, bufferCapacity: 128 }),
        drainWatcherEventsJson: () => JSON.stringify([]),
        stopWatcher: () => undefined,
        writeEventJson: () => undefined,
        listEventsJson: () => JSON.stringify([]),
        close: () => undefined,
      };
    },
  });

  try {
    const store = createDaemonStore({ rootDir, paths: createPaths(rootDir), engine: engine, statePath });
    assert.equal(store.statePath, statePath);
    assert.equal(openedStatePath, statePath);
    assert.notEqual(store.statePath, path.join(rootDir, ".opencanon", "state.sqlite"));
    store.close();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
