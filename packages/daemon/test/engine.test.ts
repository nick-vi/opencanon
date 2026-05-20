import assert from "node:assert/strict";
import { test } from "vitest";
import { createEngine, loadEngine, engineBindingName, validateEngineVersion } from "@opencanon/engine";

test("engine loader names pinned platform binaries and validates version payload", () => {
  assert.equal(engineBindingName("opencanon", "darwin", "arm64"), "opencanon.darwin-arm64.node");
  assert.equal(engineBindingName("opencanon", "linux", "x64"), "opencanon.linux-x64-gnu.node");

  const version = validateEngineVersion({
    packageVersion: "0.1.0",
    engineVersion: "0.1.0",
    napiVersion: "3.9.0",
    schemaVersion: 1,
  });

  assert.equal(version.napiVersion, "3.9.0");
});

test("engine loader fails fast when binary is missing", () => {
  assert.throws(
    () => loadEngine("__missing_opencanon_test__"),
    (error) => {
      assert(error instanceof Error);
      assert.equal((error as { diagnostics?: Array<{ code: string }> }).diagnostics?.[0]?.code, "engine-binary-missing");
      return true;
    },
  );
});

test("engine JSON binding is wrapped in typed contracts", () => {
  const engine = createEngine({
    versionJson: () => JSON.stringify({ packageVersion: "0.1.0", engineVersion: "0.1.0", napiVersion: "3.9.0", schemaVersion: 1 }),
    openProjectJson: () => ({
      statusJson: () =>
        JSON.stringify({
          rootDir: "/repo",
          statePath: "/repo/.opencanon/state.sqlite",
          schemaVersion: 1,
          migrationsApplied: [1],
          watcher: { running: true, bufferedEvents: 0, stale: false },
        }),
      scanAndDiffJson: () =>
        JSON.stringify({
          statePath: "/repo/.opencanon/state.sqlite",
          schemaVersion: 1,
          inventoryHash: "inventory",
          files: [{ path: "src/company.ts", contentHash: "hash", size: 42, stale: false }],
          changedFiles: ["src/company.ts"],
          unchangedFiles: [],
          deletedFiles: [],
          staleFiles: 0,
        }),
      extractFactsJson: () =>
        JSON.stringify({
          files: [
            {
              path: "src/company.ts",
              contentHash: "hash",
              language: "typescript",
              parser: "oxc",
              parserVersion: "oxc-0.128.0",
            },
          ],
          diagnostics: [],
        }),
      buildRepoGraphJson: () => JSON.stringify({ graph: { rootDir: "/repo", graphHash: "graph", files: ["src/company.ts"] } }),
      indexCodeGraphJson: () =>
        JSON.stringify({ indexed: [], deleted: [], diagnostics: [], parserVersion: "oxc-0.128.0", extractorVersion: "oxc-graph-1" }),
      searchSymbolsJson: () => JSON.stringify({ symbols: [] }),
      searchReferencesJson: () => JSON.stringify({ references: [] }),
      searchGraphEdgesJson: () => JSON.stringify({ edges: [] }),
      startWatcherJson: (_request: string, callback: (error: unknown, batchJson?: string) => void) => {
        callback(null, JSON.stringify({ rootDir: "/repo", paths: ["src/company.ts"], stale: false, timestamp: "123" }));
        return JSON.stringify({ running: true, debounceMs: 250, bufferCapacity: 128 });
      },
      drainWatcherEventsJson: () => JSON.stringify([{ rootDir: "/repo", paths: ["src/company.ts"], stale: false, timestamp: "123" }]),
      stopWatcher: () => undefined,
      writeEventJson: () => undefined,
      listEventsJson: () => JSON.stringify([]),
      close: () => undefined,
    }),
  });

  assert.equal(engine.version().schemaVersion, 1);
  const project = engine.openProject({
    rootDir: "/repo",
    statePath: "/repo/.opencanon/state.sqlite",
    settings: {
      docsDir: "docs/opencanon",
      decisionsPath: "docs/opencanon/decisions.json",
      validatorsPath: ".agents/skills/opencanon/validators/index.ts",
      fixturesDir: ".agents/skills/opencanon/fixtures",
      projectFilePatterns: ["src/**/*.ts"],
      ignore: [".opencanon/**"],
      maxFiles: 20_000,
      maxFileSizeKb: 512,
      fileDiscovery: "git",
      configHash: "hash",
    },
  });
  assert.equal(project.status().schemaVersion, 1);
  assert.equal(project.scanAndDiff({ files: ["src/company.ts"] }).inventoryHash, "inventory");
  assert.equal(project.startWatcher({}, () => undefined).running, true);
  assert.deepEqual(project.drainWatcherEvents()[0].paths, ["src/company.ts"]);
  project.stopWatcher();
  assert.deepEqual(project.listEvents(), []);
  assert.equal(
    project.extractFacts({
      files: [{ path: "src/company.ts", contentHash: "hash", language: "typescript" }],
      facts: ["imports"],
      parserVersion: "oxc-0.128.0",
    }).files[0].parser,
    "oxc",
  );
  assert.equal(project.buildRepoGraph({ facts: [], packageManifests: [] }).graph.graphHash, "graph");
  assert.deepEqual(project.searchReferences({ query: "findCompany" }).references, []);
});
