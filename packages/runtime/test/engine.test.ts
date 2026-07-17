import assert from "node:assert/strict";
import { test } from "vitest";
import { createEngine, loadEngine, engineBindingName, validateEngineVersion } from "@opencanon/engine";
import { assignedProjectPublication, assignedProtocolEvent, emptyProtocolEventWindow, initialProjectPublication, fakeInferenceEngineBinding } from "./engine-binding-test-support.ts";

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

test("engine JSON binding is wrapped in typed contracts", async () => {
  let productModelProjection: unknown = null;
  let observabilityRecords: { traces: unknown[]; spans: unknown[]; events: unknown[] } = { traces: [], spans: [], events: [] };
  let semanticIndex: unknown = null;
  let semanticResults: unknown[] = [];
  let job: unknown = null;
  const jobEvents: unknown[] = [];
  const engine = createEngine({
    ...fakeInferenceEngineBinding(2),
    versionJson: () => JSON.stringify({ packageVersion: "0.1.0", engineVersion: "0.1.0", napiVersion: "3.9.0", schemaVersion: 1 }),
    openProjectJson: () => ({
      statusJson: () =>
        JSON.stringify({
          rootDir: "/repo",
          statePath: "/repo/.opencanon/state/test/state.sqlite",
          schemaVersion: 1,
          migrationsApplied: [1],
          refresh: { status: "live", mode: "watch", bufferedEvents: 0 },
        }),
      scanAndDiffJson: () =>
        JSON.stringify({
          statePath: "/repo/.opencanon/state/test/state.sqlite",
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
      indexCodeGraphJson: async () =>
        JSON.stringify({ generation: "test", indexed: [], deleted: [], diagnostics: [], parserVersion: "oxc-0.128.0", extractorVersion: "oxc-graph-1" }),
      searchSymbolsJson: () => JSON.stringify({ symbols: [] }),
      searchReferencesJson: () => JSON.stringify({ references: [] }),
      searchGraphEdgesJson: () => JSON.stringify({ edges: [] }),
      readProductModelProjectionJson: () => JSON.stringify({ projection: productModelProjection }),
      readProjectPublicationJson: initialProjectPublication,
      publishProjectStateJson: (requestJson: string) => {
        const request = JSON.parse(requestJson) as { productModel?: unknown };
        if (request.productModel) productModelProjection = request.productModel;
        return assignedProjectPublication(requestJson);
      },
      writeSemanticIndexJson: (requestJson: string) => {
        const request = JSON.parse(requestJson) as { index: unknown; chunks: Array<{ metadata: unknown }> };
        semanticIndex = request.index;
        semanticResults = request.chunks.map((chunk) => ({ chunk: chunk.metadata, score: 1 }));
      },
      writeSemanticIndexDeltaJson: () => undefined,
      readSemanticIndexStatusJson: () => JSON.stringify({ index: semanticIndex }),
      listSemanticChunksJson: () => JSON.stringify({ index: semanticIndex, chunks: (semanticResults as Array<{ chunk: unknown }>).map((result) => result.chunk) }),
      searchSemanticIndexJson: () => JSON.stringify({ index: semanticIndex, results: semanticResults }),
      startWatcherJson: (_request: string, callback: (error: unknown, batchJson?: string) => void) => {
        callback(null, JSON.stringify({ rootDir: "/repo", paths: ["src/company.ts"], stale: false, timestamp: "123" }));
        return JSON.stringify({ running: true, debounceMs: 250, bufferCapacity: 128 });
      },
      drainWatcherEventsJson: () => JSON.stringify([{ rootDir: "/repo", paths: ["src/company.ts"], stale: false, timestamp: "123" }]),
      stopWatcher: () => undefined,
      writeEventJson: () => undefined,
      listEventsJson: () => JSON.stringify([]),
      appendProtocolEventJson: (requestJson: string) => assignedProtocolEvent(requestJson),
      listProtocolEventsJson: () => emptyProtocolEventWindow(),
      writeJobJson: (requestJson: string) => {
        job = (JSON.parse(requestJson) as { job: unknown }).job;
      },
      readJobJson: () => JSON.stringify({ job }),
      listJobsJson: () => JSON.stringify(job ? [job] : []),
      admitJobsJson: (requestJson: string) => {
        const request = JSON.parse(requestJson) as { jobs: unknown[]; capacity: number };
        return JSON.stringify({ accepted: true, activeCount: request.jobs.length, requestedCount: request.jobs.length, capacity: request.capacity });
      },
      pruneJobsJson: () => JSON.stringify({ deletedRuns: 0, deletedEvents: 0, retainedTerminalRuns: job ? 1 : 0 }),
      appendJobEventJson: (requestJson: string) => {
        const event = { ...(JSON.parse(requestJson) as { event: Record<string, unknown> }).event, sequence: jobEvents.length + 1 };
        jobEvents.push(event);
        return JSON.stringify(event);
      },
      listJobEventsJson: () => JSON.stringify(jobEvents),
      writeObservabilityRecordsJson: (requestJson: string) => {
        const request = JSON.parse(requestJson) as { traces?: unknown[]; spans?: unknown[]; events?: unknown[] };
        observabilityRecords = {
          traces: [...observabilityRecords.traces, ...(request.traces ?? [])],
          spans: [...observabilityRecords.spans, ...(request.spans ?? [])],
          events: [...observabilityRecords.events, ...(request.events ?? [])],
        };
      },
      listObservabilityRecordsJson: () => JSON.stringify(observabilityRecords),
      close: () => undefined,
    }),
  });

  assert.equal(engine.version().schemaVersion, 1);
  const project = engine.openProject({
    rootDir: "/repo",
    statePath: "/repo/.opencanon/state/test/state.sqlite",
    codeGraphStatePath: "/repo/.opencanon/state/test/state.sqlite",
    settings: {
      docsDir: "docs/opencanon",
      conventionsPath: "opencanon/conventions/index.ts",
      fixturesDir: "opencanon/fixtures",
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
  assert.deepEqual(project.listEvents({ mode: "recent", limit: 50 }), []);
  const run = {
    id: "run-1",
    batchId: "batch-1",
    kind: "change-check",
    status: "queued",
    changeId: "runtime-operations",
    checkId: "engine-tests",
    checkKind: "command",
    executor: { runtimeNamespace: "test", leaseId: "engine-test" },
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    outputTail: "",
    outputBytes: 0,
    outputTruncated: false,
  } as const;
  project.writeJob(run);
  assert.equal(project.readJob(run.id)?.status, "queued");
  assert.equal(project.listJobs({ mode: "recent", limit: 50 }).length, 1);
  project.appendJobEvent({ runId: run.id, batchId: run.batchId, timestamp: "2026-07-12T00:00:01.000Z", type: "started" });
  assert.equal(project.listJobEvents({ jobId: run.id, afterSequence: 0, limit: 50, order: "asc" })[0]?.sequence, 1);
  project.writeObservabilityRecords({
    traces: [
      {
        id: "1234567890abcdef1234567890abcdef",
        name: "runtime.check",
        status: "ok",
        recording: true,
        sampled: true,
        startedAt: "2026-06-06T00:00:00.000Z",
        endedAt: "2026-06-06T00:00:00.010Z",
        durationMs: 10,
        attributes: { command: "doctor" },
        traceFlags: "01",
      },
    ],
  });
  assert.equal(project.listObservabilityRecords().traces[0].name, "runtime.check");
  assert.equal(
    project.extractFacts({
      files: [{ path: "src/company.ts", contentHash: "hash", language: "typescript" }],
      facts: ["imports"],
      parserVersion: "oxc-0.128.0",
    }).files[0].parser,
    "oxc",
  );
  assert.equal(project.buildRepoGraph({ facts: [], packageManifests: [] }).graph.graphHash, "graph");
  assert.deepEqual((await project.indexCodeGraph({ files: [], parserVersion: "oxc-0.128.0" })).indexed, []);
  assert.deepEqual(project.searchReferences({ query: "findCompany" }).references, []);
  const publication = project.publishProjectState({
    revision: 2,
    codeGraphGeneration: "test",
    productModel: {
      indexedAt: "2026-06-06T00:00:00.000Z",
      graphHash: "definition-graph",
      definitionsHash: "definitions",
      counts: {
      areas: 0,
      specs: 0,
      changes: 0,
      conventions: 0,
      impactSurfaces: 0,
      validators: 0,
      nodes: 0,
      edges: 0,
      diagnostics: 0,
      },
      areas: [],
      specs: [],
      changes: [],
      conventions: [],
      impactSurfaces: [],
      validators: [],
      definitionGraph: {
        nodes: [],
        edges: [],
        diagnostics: [],
        fileCoverage: {},
        backlinks: {
          areaToSurfaces: {},
          specToSurfaces: {},
          changeToSurfaces: {},
          surfaceToAreas: {},
          surfaceToSpecs: {},
          surfaceToChanges: {},
          surfaceToConventions: {},
        },
      },
    },
    protocolEvent: {
      protocolVersion: 1,
      timestamp: "2026-06-06T00:00:00.000Z",
      revision: 2,
      domain: "project",
      type: "published",
      summary: "Published Project State.",
      ids: [],
    },
    maxProtocolEventCount: 100,
    retainProtocolEventsAfter: "2026-06-01T00:00:00.000Z",
  });
  assert.equal(publication.publication.revision, 2);
  assert.equal(project.readProductModelProjection()?.graphHash, "definition-graph");
  project.writeSemanticIndex({
    index: {
      id: "project",
      version: "semantic-index-v3",
      status: "ready",
      provider: {
        id: "opencanon-gguf-jina-code-v2",
        kind: "gguf",
        displayName: "Jina Code v2",
        modelId: "jina-code-v2",
        modelDigest: "model",
        dimensions: 896,
        distance: "cosine",
        configHash: "config",
      },
      chunkerVersion: "chunker",
      producerVersion: "producer",
      sourceInventoryHash: "inventory",
      chunkTreeHash: "chunk-tree",
      identityHash: "identity",
      chunkCount: 1,
      vectorCount: 1,
      staleChunkCount: 0,
      indexedAt: "2026-06-06T00:00:00.000Z",
      diagnostics: [],
    },
    chunks: [
      {
        metadata: {
          id: "chunk:one",
          path: "src/company.ts",
          contentHash: "content",
          chunkHash: "chunk",
          embeddingHash: "embedding",
          kind: "file",
          language: "typescript",
          ordinal: 0,
          range: { start: { line: 1, column: 1, byte: 0 }, end: { line: 1, column: 10, byte: 10 } },
          tokenCount: 2,
          preview: "company code",
        },
        text: "company code",
        vector: [1, ...Array.from({ length: 895 }, () => 0)],
      },
    ],
  });
  assert.equal(project.readSemanticIndexStatus().index?.chunkCount, 1);
  assert.equal(project.searchSemanticIndex({ vector: [1, ...Array.from({ length: 895 }, () => 0)] }).results[0].chunk.path, "src/company.ts");
  assert.equal(project.listSemanticChunks({ paths: ["src/company.ts"] }).chunks[0].path, "src/company.ts");
  const inference = engine.openInferenceRuntime({
    modelId: "jina-code-v2",
    nGpuLayers: 0,
    nThreads: 2,
    nCtx: 128,
    nBatch: 128,
    nUbatch: 64,
    nSeqMax: 16,
  });
  assert.equal(inference.describe().dimensions, 2);
  assert.deepEqual(inference.countTokens({ task: "query", texts: ["company"] }).tokenCounts, [2]);
  assert.equal(inference.embed({ task: "query", texts: ["company"] }).vectors[0].length, 2);

  productModelProjection = {
    indexedAt: "2026-06-05T00:00:00.000Z",
    graphHash: "stale-definition-graph",
    definitionsHash: "stale-definitions",
    counts: {
      areas: 1,
      changes: 1,
      conventions: 1,
      impactSurfaces: 1,
      validators: 1,
      nodes: 1,
      edges: 0,
      diagnostics: 0,
    },
    areas: [],
    changes: [],
    conventions: [],
    impactSurfaces: [],
    validators: [],
    definitionGraph: {
      nodes: [],
      edges: [],
      diagnostics: [],
      fileCoverage: {},
      backlinks: {
        areaToSurfaces: {},
        changeToSurfaces: {},
        surfaceToAreas: {},
        surfaceToChanges: {},
        surfaceToConventions: {},
      },
    },
  };
  assert.equal(project.readProductModelProjection(), null);
});
