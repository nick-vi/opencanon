import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ContextRequestSchema,
  RuntimeHealthSchema,
  ChangeCheckRunEventDraftSchema,
  ChangeCheckRunEventSchema,
  RuntimeHealthSummarySchema,
  RuntimeProjectSummarySchema,
  RuntimeResponseSchema,
  RuntimeWorkerJobKindValue,
  RuntimeWorkerJobStatusValue,
  summarizeRuntimeHealth,
  ExtractFactsRequestSchema,
  ExtractFactsResultSchema,
  FileFactsSchema,
  EngineVersionSchema,
  EngineProjectStatusSchema,
  OpenCanonError,
  OpenCanonErrorPayloadKind,
  OpenCanonProblemCode,
  OpenCanonProblemSource,
  OpenProjectRequestSchema,
  SearchGraphEdgesRequestSchema,
  SearchGraphEdgesResultSchema,
  SearchSemanticIndexRequestSchema,
  SearchReferencesRequestSchema,
  SearchReferencesResultSchema,
  ScanAndDiffResultSchema,
  ValidateRequestSchema,
  ValidatorContractSchema,
  WatcherEventBatchSchema,
  WatcherStartRequestSchema,
  WriteSemanticIndexRequestSchema,
  createOpenCanonDiagnostic,
  createOpenCanonProblem,
  createOpenCanonFailure,
  formatOpenCanonErrorPayload,
  formatOpenCanonDiagnostics,
  parseJson,
  parseOpenCanonProblem,
  resultAll,
  serializeOpenCanonProblem,
  stringifyJson,
  branch,
  err,
  isErr,
  isOk,
  ok,
  matchesProjectFileScope,
  DefaultSemanticEmbeddingConfig,
  semanticEmbeddingModel,
  SemanticEmbeddingModelId,
  SemanticEmbeddingProviderKind,
  semanticEmbeddingModelIds,
  type ContextPaths,
} from "@opencanon/core";

test("file facts schema defaults optional fact arrays", () => {
  const facts = FileFactsSchema.parse({
    path: "src/company.ts",
    contentHash: "hash",
    language: "typescript",
    parser: "oxc",
    parserVersion: "0.128.0",
  });

  assert.deepEqual(facts.imports, []);
  assert.deepEqual(facts.exports, []);
  assert.deepEqual(facts.symbols, []);
  assert.deepEqual(facts.declarations, []);
  assert.deepEqual(facts.calls, []);
  assert.deepEqual(facts.literals, []);
  assert.deepEqual(facts.comments, []);
  assert.deepEqual(facts.diagnostics, []);
});

test("validator contract requires explicit scope", () => {
  assert.equal(
    ValidatorContractSchema.safeParse({
      id: "service-boundary",
      topics: ["service"],
      severity: "error",
      applies: ["src/services/**/*.ts"],
    }).success,
    false,
  );

  const validator = ValidatorContractSchema.parse({
    id: "service-boundary",
    topics: ["service"],
    severity: "error",
    scope: "import-edge",
    facts: ["imports"],
    applies: ["src/services/**/*.ts"],
    conventionIds: ["service-db-boundary"],
    docs: ["docs/opencanon/canon/architecture.md#services"],
  });

  assert.equal(validator.scope, "import-edge");
  assert.deepEqual(validator.facts, ["imports"]);
  assert.deepEqual(validator.docs, ["docs/opencanon/canon/architecture.md#services"]);
});

test("engine project contract parses fact requests and results", () => {
  assert.deepEqual(
    EngineVersionSchema.parse({
      packageVersion: "0.1.0",
      engineVersion: "0.1.0",
      napiVersion: "3.9.0",
      schemaVersion: 1,
    }).schemaVersion,
    1,
  );

  const request = ExtractFactsRequestSchema.parse({
    files: [{ path: "src/company.ts", contentHash: "hash", language: "typescript", content: "export const value = true;\n" }],
    facts: ["imports", "symbols"],
    parserVersion: "0.128.0",
  });
  assert.deepEqual(request.facts, ["imports", "symbols"]);
  assert.equal(request.files[0]?.content, "export const value = true;\n");

  const result = ExtractFactsResultSchema.parse({
    files: [
      {
        path: "src/company.ts",
        contentHash: "hash",
        language: "typescript",
        parser: "oxc",
        parserVersion: "0.128.0",
        imports: [{ source: "./dal", specifiers: ["findCompany"], kind: "import", resolution: "relative", line: 1 }],
      },
    ],
  });
  assert.equal(result.files[0].imports[0].source, "./dal");
});

test("code reference contracts parse indexed references", () => {
  assert.deepEqual(SearchReferencesRequestSchema.parse({ query: "logger", limit: 20 }), {
    query: "logger",
    limit: 20,
  });

  const result = SearchReferencesResultSchema.parse({
    references: [
      {
        id: "ref",
        path: "src/company.ts",
        language: "typescript",
        name: "logger",
        kind: "import-named",
        source: "./log",
        range: {
          start: { line: 1, column: 10, byte: 9 },
          end: { line: 1, column: 16, byte: 15 },
        },
        provenance: "oxc",
        confidence: "syntactic",
      },
    ],
  });

  assert.equal(result.references[0].source, "./log");
});

test("code graph edge contracts parse resolved edges", () => {
  assert.deepEqual(SearchGraphEdgesRequestSchema.parse({ query: "logger", direction: "incoming", limit: 20 }), {
    query: "logger",
    direction: "incoming",
    limit: 20,
  });

  const symbol = {
    id: "symbol",
    path: "src/company.ts",
    language: "typescript",
    kind: "function",
    name: "logger",
    qualifiedName: "src/company.ts::logger",
    exported: true,
    range: {
      start: { line: 1, column: 17, byte: 16 },
      end: { line: 1, column: 23, byte: 22 },
    },
  };
  const result = SearchGraphEdgesResultSchema.parse({
    edges: [
      {
        id: "edge",
        kind: "call",
        provenance: "oxc",
        confidence: "exact",
        path: "src/company.ts",
        range: { start: { line: 2, column: 3, byte: 32 } },
        source: { ...symbol, id: "source", name: "run", qualifiedName: "src/company.ts::run" },
        target: symbol,
      },
    ],
  });

  assert.equal(result.edges[0].target.name, "logger");
});

test("runtime request and response contracts have deterministic defaults", () => {
  assert.deepEqual(ValidateRequestSchema.parse({ changed: true }), {
    files: [],
    changed: true,
    all: false,
    strictWarnings: false,
    validatorIds: [],
    topics: [],
  });

  assert.deepEqual(ContextRequestSchema.parse({ query: "dal" }), {
    files: [],
    changed: false,
    query: "dal",
    topics: [],
  });

  const failure = RuntimeResponseSchema.parse({
    ok: false,
    error: {
      kind: "diagnostics",
      diagnostics: [
        {
          code: "runtime-not-running",
          message: "OpenCanon runtime is not running.",
          action: "Run opencanon project start.",
        },
      ],
    },
  });

  assert.equal(failure.ok, false);
  if (!failure.ok) assert.equal(failure.error.kind, OpenCanonErrorPayloadKind.Diagnostics);
});

test("runtime health contract exposes explicit worker jobs", () => {
  const health = RuntimeHealthSchema.parse({
    status: "indexing",
    engine: {
      packageVersion: "0.4.0-test",
      engineVersion: "0.4.0-test",
      napiVersion: "test",
      schemaVersion: 6,
    },
    refresh: { status: "live", mode: "watch", bufferedEvents: 0 },
    startedAt: "2026-06-27T00:00:00.000Z",
    jobs: [
      {
        id: "semantic-index:test",
        kind: RuntimeWorkerJobKindValue.SemanticIndex,
        status: RuntimeWorkerJobStatusValue.Running,
        label: "Refreshing Project Knowledge",
        current: 2,
        total: 5,
        unit: "files",
      },
    ],
  });

  assert.equal(health.jobs?.[0]?.kind, RuntimeWorkerJobKindValue.SemanticIndex);
  assert.equal(health.jobs?.[0]?.status, RuntimeWorkerJobStatusValue.Running);
  assert.equal(RuntimeHealthSchema.safeParse({ ...health, jobs: [{ ...health.jobs?.[0], status: "unknown" }] }).success, false);
});

test("public runtime summaries replace validator dependency paths with a bounded count", () => {
  const health = RuntimeHealthSchema.parse({
    status: "ready",
    engine: { packageVersion: "0.4.5", engineVersion: "0.4.5", napiVersion: "test", schemaVersion: 7 },
    refresh: { status: "live", mode: "watch", bufferedEvents: 0 },
    startedAt: "2026-07-12T00:00:00.000Z",
    validatorGraph: {
      entrypoint: "opencanon/conventions/index.ts",
      hash: "validator-graph-hash",
      loadedAt: "2026-07-12T00:00:00.000Z",
      validatorCount: 25,
      dependencyFiles: Array.from({ length: 10_000 }, (_item, index) => `opencanon/conventions/rule-${index}.ts`),
    },
  });

  const summary = summarizeRuntimeHealth(health);
  assert.equal(summary.validatorGraph?.dependencyCount, 10_000);
  assert.equal("dependencyFiles" in (summary.validatorGraph ?? {}), false);
  assert.equal("entrypoint" in (summary.validatorGraph ?? {}), false);
  assert.equal(RuntimeHealthSummarySchema.safeParse(summary).success, true);
  const project = RuntimeProjectSummarySchema.parse({
    rootDir: "/repo",
    lifecycle: { phase: "ready", revision: { observed: 1, accepted: 1, published: 1 }, settled: true },
    health: summary,
    files: 1,
    findings: 0,
    staleFiles: 0,
  });
  assert(JSON.stringify(project).length < 4_096);
});

test("Change check terminal events require matching run status", () => {
  const run = {
    id: "run-1",
    batchId: "batch-1",
    kind: "change-check",
    status: "failed",
    changeId: "change-1",
    checkId: "check-1",
    checkKind: "command",
    executor: { runtimeNamespace: "test", leaseId: "contract-test" },
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:01.000Z",
    startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:00:01.000Z",
    summary: "Failed.",
    outputTail: "",
    outputBytes: 0,
    outputTruncated: false,
  };
  assert.equal(ChangeCheckRunEventSchema.safeParse({ runId: "run-1", batchId: "batch-1", sequence: 1, timestamp: "2026-07-12T00:00:01.000Z", type: "passed", run }).success, false);
});

test("Change check event drafts leave sequence allocation to Project State", () => {
  const draft = { runId: "run-1", batchId: "batch-1", timestamp: "2026-07-12T00:00:01.000Z", type: "started" };
  assert.equal(ChangeCheckRunEventDraftSchema.safeParse(draft).success, true);
  assert.equal(ChangeCheckRunEventDraftSchema.safeParse({ ...draft, sequence: 1 }).success, false);
});

test("project scope filtering applies project patterns and ignores", () => {
  const paths: ContextPaths = {
    rootDir: "/repo",
    configPath: "/repo/opencanon.config.json",
    docsDir: "docs/opencanon",
    conventionsPath: "opencanon/conventions/index.ts",
    areasPath: "opencanon/areas/index.ts",
    specsPath: "opencanon/specs/index.ts",
    changesPath: "opencanon/changes/index.ts",
    fixturesDir: "opencanon/fixtures",
    impactSurfacesPath: "docs/opencanon/impact-surfaces.json",
    proposedImpactNotesPath: "docs/opencanon/proposed-impact-notes.json",
    baselinePath: ".opencanon/baseline.json",
    commitApprovalsPath: ".opencanon/commit-approvals.json",
    commitApprovalsPersistent: false,
    cacheDir: ".opencanon/cache",
    projectFilePatterns: ["src/**/*.ts", "tests/**/*.ts", "docs/**/*.{md,markdown}", "*.{md,markdown}"],
    ignore: ["packages/**", ".agents/**"],
    entrypoints: [],
    publicSurfaces: [],
    generated: [],
    externalTools: {},
    requiredPackageScripts: ["opencanon"],
    fileDiscovery: "git",
    maxFiles: 20_000,
    maxFileSizeKb: 512,
    semanticEmbedding: DefaultSemanticEmbeddingConfig,
  };

  assert.equal(matchesProjectFileScope(paths, "src/company.ts"), true);
  assert.equal(matchesProjectFileScope(paths, "docs/opencanon/canon/architecture.md"), true);
  assert.equal(matchesProjectFileScope(paths, "README.md"), true);
  assert.equal(matchesProjectFileScope(paths, "packages/cli/src/index.ts"), false);
  assert.equal(matchesProjectFileScope(paths, ".agents/skills/opencanon/SKILL.md"), false);
});

test("engine project state contracts parse project handles and scan results", () => {
  const request = OpenProjectRequestSchema.parse({
    rootDir: "/repo",
    statePath: "/repo/.opencanon/state/test/state.sqlite",
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
  const status = EngineProjectStatusSchema.parse({
    rootDir: request.rootDir,
    statePath: request.statePath,
    schemaVersion: 1,
    migrationsApplied: [1],
    refresh: { status: "live", mode: "watch", bufferedEvents: 0 },
  });
  const scan = ScanAndDiffResultSchema.parse({
    statePath: request.statePath,
    schemaVersion: status.schemaVersion,
    inventoryHash: "inventory",
    files: [{ path: "src/company.ts", contentHash: "hash", size: 42, stale: false }],
    changedFiles: ["src/company.ts"],
    unchangedFiles: [],
    deletedFiles: [],
    staleFiles: 0,
  });

  assert.equal(status.schemaVersion, 1);
  assert.equal(status.refresh.status, "live");
  assert.equal(scan.changedFiles[0], "src/company.ts");
});

test("engine watcher contracts default options and parse event batches", () => {
  assert.deepEqual(WatcherStartRequestSchema.parse({}), {
    debounceMs: 250,
    bufferCapacity: 128,
  });

  const batch = WatcherEventBatchSchema.parse({
    rootDir: "/repo",
    paths: ["src/company.ts"],
    stale: false,
    timestamp: "123",
  });

  assert.equal(batch.paths[0], "src/company.ts");
});

test("semantic index contracts require provider identity and chunk metadata", () => {
  const request = WriteSemanticIndexRequestSchema.parse({
    index: {
      id: "project",
      version: "semantic-index-v2",
      status: "ready",
      provider: {
        id: "opencanon-native-jina-code-v2",
        kind: "native",
        displayName: "Jina Code v2",
        modelId: "jina-code-v2",
        modelDigest: "model-hash",
        dimensions: 896,
        distance: "cosine",
        configHash: "config-hash",
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
          range: { start: { line: 1, column: 1, byte: 0 }, end: { line: 2, column: 1, byte: 20 } },
          tokenEstimate: 5,
          preview: "company loader",
        },
        text: "company loader",
        vector: [1, ...Array.from({ length: 895 }, () => 0)],
      },
    ],
  });
  const search = SearchSemanticIndexRequestSchema.parse({ vector: [1, ...Array.from({ length: 895 }, () => 0)] });

  assert.equal(request.index.provider.modelId, "jina-code-v2");
  assert.equal(request.chunks[0].metadata.embeddingHash, "embedding");
  assert.equal(search.indexId, "project");
  assert.equal(search.limit, 20);
});

test("semantic embedding model registry exposes native embedding models", () => {
  const native = semanticEmbeddingModel(SemanticEmbeddingModelId.JinaCodeV2);

  assert.equal(native.providerKind, SemanticEmbeddingProviderKind.Native);
  assert.equal(native.dimensions, 896);
  assert.equal(semanticEmbeddingModelIds().every((id) => semanticEmbeddingModel(id).providerKind === SemanticEmbeddingProviderKind.Native), true);
  assert(semanticEmbeddingModelIds().includes(SemanticEmbeddingModelId.Qwen3Embed));
});

test("open canon diagnostics are structured and formatted", () => {
  const problem = createOpenCanonProblem({
    code: OpenCanonProblemCode.ProjectNotFound,
    title: "OpenCanon project not found",
    detail: "No OpenCanon project was discovered for the requested root.",
    source: OpenCanonProblemSource.Service,
    path: "/tmp/missing",
    action: "Run opencanon init --yes.",
    retryable: false,
    status: 400,
  });
  const diagnostic = createOpenCanonDiagnostic({
    code: "engine-binary-missing",
    message: "Engine binary is missing.",
    details: ["Expected packages/engine/binaries/opencanon.darwin-arm64.node."],
    action: "Run npm run build:engine.",
    problem,
  });
  const failure = createOpenCanonFailure([diagnostic]);
  const error = new OpenCanonError([diagnostic]);

  assert.equal(failure.ok, false);
  assert.equal(failure.error.kind, OpenCanonErrorPayloadKind.Diagnostics);
  if (failure.error.kind === OpenCanonErrorPayloadKind.Diagnostics) {
    assert.equal(failure.error.diagnostics[0]?.problem?.code, OpenCanonProblemCode.ProjectNotFound);
  }
  assert.equal(parseOpenCanonProblem(serializeOpenCanonProblem(problem))?.path, "/tmp/missing");
  assert.equal(parseOpenCanonProblem(failure)?.code, OpenCanonProblemCode.ProjectNotFound);
  assert(error.message.includes("[engine-binary-missing]"));
  assert(formatOpenCanonErrorPayload(failure.error).includes("[engine-binary-missing]"));
  assert(formatOpenCanonDiagnostics([diagnostic]).includes("Run npm run build:engine."));
});

test("core result and utility helpers are JSON-native", () => {
  const success = ok({ id: "project" });
  const failure = err({ code: "missing" });

  assert.equal(isOk(success), true);
  assert.equal(isErr(failure), true);
  assert.deepEqual(JSON.parse(JSON.stringify(success)), { ok: true, data: { id: "project" } });
  const combined = resultAll([ok("a"), ok(1)]);
  assert.equal(combined.ok, true);
  if (combined.ok) assert.deepEqual(combined.data, ["a", 1]);

  const parsed = parseJson<{ ok: boolean }>(`{"ok":true}`);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.data.ok, true);
  assert.equal(parseJson("{").ok, false);
  assert.equal(stringifyJson({ a: 1 }).ok, true);

  const value = branch<string>()
    .when(false, "wrong")
    .present(0, (number) => `zero:${number}`)
    .else("fallback");
  assert.equal(value, "zero:0");
});
