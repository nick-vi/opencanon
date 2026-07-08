import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { buildProjectSemanticIndex, buildRuntimeSnapshot, createProjectStore, semanticSearchVector, semanticSearchVectorForProvider } from "@opencanon/runtime";
import { createEngine } from "@opencanon/engine";
import { createEphemeralValidationResultCache, createPaths, type FileFacts, type ScanAndDiffResult, type WriteSemanticIndexRequest } from "@opencanon/core";
import { createAuthoringProject } from "./support.ts";

test("runtime semantic index chunks files with deterministic local vectors", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/company.ts"), "export function loadCompany() {\n  return 'active company';\n}\n");
    writeFileSync(path.join(rootDir, "src/native.rs"), "fn load_company() {}\n");
    const facts: FileFacts[] = [
      {
        path: "src/company.ts",
        contentHash: "content",
        language: "typescript",
        parser: "oxc",
        parserVersion: "test",
        imports: [],
        exports: [{ line: 1, column: 1, name: "loadCompany", kind: "function" }],
        symbols: [{ line: 1, column: 17, name: "loadCompany", kind: "function", exported: true, endLine: 3, params: [] }],
        declarations: [],
        calls: [],
        literals: [{ line: 2, column: 10, value: "active company", valueKind: "string", context: "return" }],
        comments: [],
        references: [],
        annotations: [],
        diagnosticFacts: [],
        duplicates: [],
        diagnostics: [],
      },
    ];

    const build = buildProjectSemanticIndex({
      rootDir,
      scan: {
        statePath: path.join(rootDir, ".opencanon/state.sqlite"),
        schemaVersion: 6,
        inventoryHash: "inventory",
        files: [
          { path: "src/company.ts", contentHash: "content", size: 64, stale: false },
          { path: "src/native.rs", contentHash: "rust", size: 20, stale: false },
        ],
        changedFiles: ["src/company.ts"],
        unchangedFiles: [],
        deletedFiles: [],
        staleFiles: 0,
      },
      facts,
    });

    assert.equal(build.index.id, "project");
    assert.equal(build.index.status, "ready");
    assert.equal(build.index.provider.dimensions, 128);
    assert.equal(build.index.provider.kind, "local");
    assert.equal(build.index.chunkTreeHash.length, 64);
    assert.equal(build.index.chunkCount, build.chunks.length);
    assert.deepEqual(build.index.embeddingStats, {
      totalChunks: 1,
      embeddedChunks: 1,
      reusedChunks: 0,
    });
    assert.equal(build.chunks.length, 1);
    assert.equal(build.chunks[0].metadata.path, "src/company.ts");
    assert.equal(build.chunks[0].metadata.kind, "symbol");
    assert.equal(build.chunks[0].metadata.symbol, "loadCompany");
    assert.equal(build.chunks[0].metadata.embeddingHash.length, 64);
    assert(build.chunks[0].text.includes("Exported function: loadCompany"));
    assert.equal(build.chunks[0].vector.length, 128);
    assert.equal(semanticSearchVector("active company").length, 128);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime semantic index makes duplicate fact chunk ids unique", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-duplicate-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/company.ts"), "export function loadCompany() {\n  return 'active company';\n}\n");
    const duplicateDeclaration = {
      line: 1,
      column: 17,
      name: "loadCompany",
      kind: "function" as const,
      exported: true,
      endLine: 3,
      text: "export function loadCompany() {\n  return 'active company';\n}",
      members: [],
    };
    const build = buildProjectSemanticIndex({
      rootDir,
      scan: {
        statePath: path.join(rootDir, ".opencanon/state.sqlite"),
        schemaVersion: 6,
        inventoryHash: "inventory",
        files: [{ path: "src/company.ts", contentHash: "content", size: 64, stale: false }],
        changedFiles: ["src/company.ts"],
        unchangedFiles: [],
        deletedFiles: [],
        staleFiles: 0,
      },
      facts: [{
        path: "src/company.ts",
        contentHash: "content",
        language: "typescript",
        parser: "oxc",
        parserVersion: "test",
        imports: [],
        exports: [],
        symbols: [],
        declarations: [duplicateDeclaration, duplicateDeclaration],
        calls: [],
        literals: [],
        comments: [],
        references: [],
        annotations: [],
        diagnosticFacts: [],
        duplicates: [],
        diagnostics: [],
      }],
    });

    assert.equal(build.index.status, "ready");
    assert.equal(build.chunks.length, 2);
    assert.equal(new Set(build.chunks.map((chunk) => chunk.metadata.id)).size, build.chunks.length);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime semantic index skips historical markdown knowledge", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-historical-md-"));
  try {
    mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "docs/product-model-plan.md"),
      [
        "# Product Model And Service Architecture Notes",
        "",
        "Status: historical planning note. The current source of truth is Project Canon.",
        "",
        "Capability was old wording and should not be retrieved as current product language.",
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(rootDir, "docs/current.md"), "# Current Canon\n\nProject Canon is current.\n");

    const build = buildProjectSemanticIndex({
      rootDir,
      scan: {
        statePath: path.join(rootDir, ".opencanon/state.sqlite"),
        schemaVersion: 6,
        inventoryHash: "inventory",
        files: [
          { path: "docs/product-model-plan.md", contentHash: "historical", size: 160, stale: false },
          { path: "docs/current.md", contentHash: "current", size: 40, stale: false },
        ],
        changedFiles: ["docs/product-model-plan.md", "docs/current.md"],
        unchangedFiles: [],
        deletedFiles: [],
        staleFiles: 0,
      },
      facts: [],
    });

    assert.equal(build.index.status, "ready");
    assert.deepEqual(build.chunks.map((chunk) => chunk.metadata.path), ["docs/current.md"]);
    assert(build.index.diagnostics.some((diagnostic) => diagnostic.code === "semantic-markdown-excluded" && diagnostic.path === "docs/product-model-plan.md"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime semantic index can use native engine embeddings when selected", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-native-"));
  try {
    writeFileSync(path.join(rootDir, "README.md"), "# Company\n\nThe company search surface.\n");
    const calls: Array<{ task: string; texts: string[]; modelId: string }> = [];
    const project = {
      embedSemanticTexts(request: { task?: string; texts: string[]; modelId: string }) {
        calls.push({ task: request.task ?? "document", texts: request.texts, modelId: request.modelId });
        return {
          modelId: request.modelId,
          dimensions: 896,
          vectors: request.texts.map((_text, index) => nativeTestVector(index + 1)),
        };
      },
    } as never;

    const build = buildProjectSemanticIndex({
      rootDir,
      scan: {
        statePath: path.join(rootDir, ".opencanon/state.sqlite"),
        schemaVersion: 6,
        inventoryHash: "inventory",
        files: [{ path: "README.md", contentHash: "readme", size: 40, stale: false }],
        changedFiles: ["README.md"],
        unchangedFiles: [],
        deletedFiles: [],
        staleFiles: 0,
      },
      facts: [],
      project,
      semanticEmbedding: {
        mode: "native",
        modelId: "jina-code-v2",
        showDownloadProgress: false,
      },
    });

    assert.equal(build.index.status, "ready");
    assert.equal(build.index.provider.kind, "native");
    assert.equal(build.index.provider.modelId, "jina-code-v2");
    assert.equal(build.index.provider.dimensions, 896);
    assert.equal(build.chunks.length, 1);
    assert.equal(build.chunks[0].vector.length, 896);
    assert.equal(calls[0].task, "document");

    const queryVector = semanticSearchVectorForProvider({
      query: "company",
      provider: build.index.provider,
      project,
      semanticEmbedding: {
        mode: "native",
        modelId: "jina-code-v2",
        showDownloadProgress: false,
      },
    });
    assert.equal(queryVector.length, 896);
    assert.equal(calls[1].task, "query");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime semantic index reuses unchanged chunk embeddings", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-reuse-"));
  try {
    mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    writeFileSync(path.join(rootDir, "README.md"), "# Company\n\nThe company billing surface.\n");
    writeFileSync(path.join(rootDir, "docs/inventory.md"), "# Inventory\n\nThe first inventory model.\n");
    const calls: Array<{ task: string; texts: string[]; modelId: string }> = [];
    const project = {
      embedSemanticTexts(request: { task?: string; texts: string[]; modelId: string }) {
        calls.push({ task: request.task ?? "document", texts: request.texts, modelId: request.modelId });
        return {
          modelId: request.modelId,
          dimensions: 896,
          vectors: request.texts.map((_text, index) => nativeTestVector(index + 1)),
        };
      },
    } as never;
    const semanticEmbedding = {
      mode: "native",
      modelId: "jina-code-v2",
      showDownloadProgress: false,
    } as const;

    const first = buildProjectSemanticIndex({
      rootDir,
      scan: {
        statePath: path.join(rootDir, ".opencanon/state.sqlite"),
        schemaVersion: 6,
        inventoryHash: "inventory-one",
        files: [
          { path: "README.md", contentHash: "readme-one", size: 40, stale: false },
          { path: "docs/inventory.md", contentHash: "inventory-one", size: 42, stale: false },
        ],
        changedFiles: ["README.md", "docs/inventory.md"],
        unchangedFiles: [],
        deletedFiles: [],
        staleFiles: 0,
      },
      facts: [],
      project,
      semanticEmbedding,
    });
    assert.equal(first.index.status, "ready");
    assert.equal(first.chunks.length, 2);
    assert.deepEqual(first.index.embeddingStats, {
      totalChunks: 2,
      embeddedChunks: 2,
      reusedChunks: 0,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].texts.length, 2);
    assert(first.chunks.every((chunk) => chunk.vector.length === 896));

    writeFileSync(path.join(rootDir, "docs/inventory.md"), "# Inventory\n\nThe second inventory model adds stock counts.\n");
    const second = buildProjectSemanticIndex({
      rootDir,
      scan: {
        statePath: path.join(rootDir, ".opencanon/state.sqlite"),
        schemaVersion: 6,
        inventoryHash: "inventory-two",
        files: [
          { path: "README.md", contentHash: "readme-one", size: 40, stale: false },
          { path: "docs/inventory.md", contentHash: "inventory-two", size: 58, stale: false },
        ],
        changedFiles: ["docs/inventory.md"],
        unchangedFiles: ["README.md"],
        deletedFiles: [],
        staleFiles: 0,
      },
      facts: [],
      project,
      semanticEmbedding,
      previousChunks: first.chunks.map((chunk) => chunk.metadata),
    });

    assert.equal(second.index.status, "ready");
    assert.equal(second.chunks.length, 2);
    assert.deepEqual(second.index.embeddingStats, {
      totalChunks: 2,
      embeddedChunks: 1,
      reusedChunks: 1,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].texts.length, 1);
    assert(calls[1].texts[0].includes("second inventory model"));
    const reused = second.chunks.find((chunk) => chunk.metadata.path === "README.md");
    const changed = second.chunks.find((chunk) => chunk.metadata.path === "docs/inventory.md");
    assert(reused);
    assert(changed);
    assert.equal(reused.vector.length, 0);
    assert.equal(changed.vector.length, 896);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime snapshot startup reuses cached semantic index without rebuilding vectors", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-startup-reuse-"));
  try {
    createAuthoringProject(rootDir);
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/company.ts"), "export function loadCompany() {\n  return 'active company';\n}\n");
    const previousScan: ScanAndDiffResult = {
      statePath: path.join(rootDir, ".opencanon/state.sqlite"),
      schemaVersion: 6,
      inventoryHash: "inventory-before",
      files: [{ path: "src/company.ts", contentHash: "content-before", size: 64, stale: false }],
      changedFiles: ["src/company.ts"],
      unchangedFiles: [],
      deletedFiles: [],
      staleFiles: 0,
    };
    const nextScan: ScanAndDiffResult = {
      ...previousScan,
      inventoryHash: "inventory-after",
      changedFiles: [],
      unchangedFiles: ["src/company.ts"],
    };
    const facts: FileFacts[] = [
      {
        path: "src/company.ts",
        contentHash: "content-before",
        language: "typescript",
        parser: "oxc",
        parserVersion: "test",
        imports: [],
        exports: [{ line: 1, column: 1, name: "loadCompany", kind: "function" }],
        symbols: [{ line: 1, column: 17, name: "loadCompany", kind: "function", exported: true, endLine: 3, params: [] }],
        declarations: [],
        calls: [],
        literals: [{ line: 2, column: 10, value: "active company", valueKind: "string", context: "return" }],
        comments: [],
        references: [],
        annotations: [],
        diagnosticFacts: [],
        duplicates: [],
        diagnostics: [],
      },
    ];
    const previous = buildProjectSemanticIndex({ rootDir, scan: previousScan, facts });
    const writes: WriteSemanticIndexRequest[] = [];
    const engine = createEngine({
      versionJson: () =>
        JSON.stringify({
          packageVersion: "0.4.0-test",
          engineVersion: "0.4.0-test",
          napiVersion: "test",
          schemaVersion: 6,
        }),
      openProjectJson: () => ({
        statusJson: () =>
          JSON.stringify({
            rootDir,
            statePath: nextScan.statePath,
            schemaVersion: 6,
            migrationsApplied: [1],
            refresh: { status: "live", mode: "watch", bufferedEvents: 0 },
          }),
        scanAndDiffJson: () => JSON.stringify(nextScan),
        extractFactsJson: () => JSON.stringify({ files: facts, diagnostics: [] }),
        buildRepoGraphJson: () =>
          JSON.stringify({
            graph: {
              rootDir,
              graphHash: "graph",
              files: nextScan.files.map((file) => file.path),
              packages: [],
              importEdges: [],
            },
          }),
        indexCodeGraphJson: () => JSON.stringify({ indexed: [], deleted: [], diagnostics: [], parserVersion: "oxc-test", extractorVersion: "graph-test" }),
        searchSymbolsJson: () => JSON.stringify({ symbols: [] }),
        searchReferencesJson: () => JSON.stringify({ references: [] }),
        searchGraphEdgesJson: () => JSON.stringify({ edges: [] }),
        writeProductModelProjectionJson: () => undefined,
        readProductModelProjectionJson: () => JSON.stringify({ projection: null }),
        writeSemanticIndexJson: (requestJson: string) => {
          writes.push(JSON.parse(requestJson) as WriteSemanticIndexRequest);
        },
        readSemanticIndexStatusJson: () => JSON.stringify({ index: previous.index }),
        listSemanticChunksJson: () => JSON.stringify({ index: previous.index, chunks: previous.chunks.map((chunk) => chunk.metadata) }),
        searchSemanticIndexJson: () => JSON.stringify({ index: null, results: [] }),
        embedSemanticTextsJson: (requestJson: string) => {
          const request = JSON.parse(requestJson) as { modelId: string; texts: string[] };
          return JSON.stringify({ modelId: request.modelId, dimensions: 2, vectors: request.texts.map(() => [1, 0]) });
        },
        generateTextJson: (requestJson: string) => {
          const request = JSON.parse(requestJson) as { modelId: string };
          return JSON.stringify({ modelId: request.modelId, text: "" });
        },
        startWatcherJson: () => JSON.stringify({ running: false, debounceMs: 250, bufferCapacity: 128 }),
        drainWatcherEventsJson: () => JSON.stringify([]),
        stopWatcher: () => undefined,
        writeEventJson: () => undefined,
        listEventsJson: () => JSON.stringify([]),
        writeObservabilityRecordsJson: () => undefined,
        listObservabilityRecordsJson: () => JSON.stringify({ traces: [], spans: [], events: [] }),
        close: () => undefined,
      }),
    });
    const store = createProjectStore({ rootDir, paths: createPaths(rootDir), engine, statePath: nextScan.statePath });

    const snapshot = await buildRuntimeSnapshot({
      cwd: rootDir,
      engine,
      store,
      semanticIndexMode: "reuse",
      validationResultCache: createEphemeralValidationResultCache(),
    });

    assert.equal(writes.length, 0);
    assert.equal(snapshot.semanticIndex.status, "stale");
    assert.equal(snapshot.state.semanticIndex?.status, "stale");
    assert.equal(snapshot.semanticIndex.chunkCount, previous.index.chunkCount);
    assert.equal(snapshot.semanticIndex.staleChunkCount, previous.index.chunkCount);
    assert(snapshot.semanticIndex.diagnostics.some((diagnostic) => diagnostic.code === "semantic-index-stale-on-startup"));
    store.close();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "duplicate vector ids", message: "ID already exists: chunk:stale-vector" },
  { name: "missing reused vectors", message: "Semantic chunk chunk:stale-vector cannot reuse a missing or changed vector." },
] as const) {
  test(`runtime snapshot rebuilds semantic vectors after recoverable ${scenario.name}`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-recovery-"));
    try {
      createAuthoringProject(rootDir);
      mkdirSync(path.join(rootDir, "src"), { recursive: true });
      writeFileSync(path.join(rootDir, "src/company.ts"), "export function loadCompany() {\n  return 'active company';\n}\n");
      const scan: ScanAndDiffResult = {
        statePath: path.join(rootDir, ".opencanon/state.sqlite"),
        schemaVersion: 6,
        inventoryHash: "inventory",
        files: [{ path: "src/company.ts", contentHash: "content", size: 64, stale: false }],
        changedFiles: [],
        unchangedFiles: ["src/company.ts"],
        deletedFiles: [],
        staleFiles: 0,
      };
      const facts: FileFacts[] = [
        {
          path: "src/company.ts",
          contentHash: "content",
          language: "typescript",
          parser: "oxc",
          parserVersion: "test",
          imports: [],
          exports: [{ line: 1, column: 1, name: "loadCompany", kind: "function" }],
          symbols: [{ line: 1, column: 17, name: "loadCompany", kind: "function", exported: true, endLine: 3, params: [] }],
          declarations: [],
          calls: [],
          literals: [{ line: 2, column: 10, value: "active company", valueKind: "string", context: "return" }],
          comments: [],
          references: [],
          annotations: [],
          diagnosticFacts: [],
          duplicates: [],
          diagnostics: [],
        },
      ];
      const previous = buildProjectSemanticIndex({ rootDir, scan, facts });
      const writes: WriteSemanticIndexRequest[] = [];
      const engine = createEngine({
        versionJson: () =>
          JSON.stringify({
            packageVersion: "0.4.0-test",
            engineVersion: "0.4.0-test",
            napiVersion: "test",
            schemaVersion: 6,
          }),
        openProjectJson: () => ({
          statusJson: () =>
            JSON.stringify({
              rootDir,
              statePath: scan.statePath,
              schemaVersion: 6,
              migrationsApplied: [1],
              refresh: { status: "live", mode: "watch", bufferedEvents: 0 },
            }),
          scanAndDiffJson: () => JSON.stringify(scan),
          extractFactsJson: () => JSON.stringify({ files: facts, diagnostics: [] }),
          buildRepoGraphJson: () =>
            JSON.stringify({
              graph: {
                rootDir,
                graphHash: "graph",
                files: scan.files.map((file) => file.path),
                packages: [],
                importEdges: [],
              },
            }),
          indexCodeGraphJson: () => JSON.stringify({ indexed: [], deleted: [], diagnostics: [], parserVersion: "oxc-test", extractorVersion: "graph-test" }),
          searchSymbolsJson: () => JSON.stringify({ symbols: [] }),
          searchReferencesJson: () => JSON.stringify({ references: [] }),
          searchGraphEdgesJson: () => JSON.stringify({ edges: [] }),
          writeProductModelProjectionJson: () => undefined,
          readProductModelProjectionJson: () => JSON.stringify({ projection: null }),
          writeSemanticIndexJson: (requestJson: string) => {
            const request = JSON.parse(requestJson) as WriteSemanticIndexRequest;
            writes.push(request);
            if (writes.length === 1) {
              throw new Error(scenario.message);
            }
          },
          readSemanticIndexStatusJson: () => JSON.stringify({ index: writes.at(-1)?.index ?? previous.index }),
          listSemanticChunksJson: (requestJson: string) => {
            const request = JSON.parse(requestJson) as { limit?: number; offset?: number };
            const offset = request.offset ?? 0;
            const limit = request.limit ?? 100;
            return JSON.stringify({
              index: previous.index,
              chunks: previous.chunks.map((chunk) => chunk.metadata).slice(offset, offset + limit),
            });
          },
          searchSemanticIndexJson: () => JSON.stringify({ index: null, results: [] }),
          embedSemanticTextsJson: (requestJson: string) => {
            const request = JSON.parse(requestJson) as { modelId: string; texts: string[] };
            return JSON.stringify({ modelId: request.modelId, dimensions: 2, vectors: request.texts.map(() => [1, 0]) });
          },
          generateTextJson: (requestJson: string) => {
            const request = JSON.parse(requestJson) as { modelId: string };
            return JSON.stringify({ modelId: request.modelId, text: "" });
          },
          startWatcherJson: () => JSON.stringify({ running: false, debounceMs: 250, bufferCapacity: 128 }),
          drainWatcherEventsJson: () => JSON.stringify([]),
          stopWatcher: () => undefined,
          writeEventJson: () => undefined,
          listEventsJson: () => JSON.stringify([]),
          writeObservabilityRecordsJson: () => undefined,
          listObservabilityRecordsJson: () => JSON.stringify({ traces: [], spans: [], events: [] }),
          close: () => undefined,
        }),
      });
      const store = createProjectStore({ rootDir, paths: createPaths(rootDir), engine, statePath: scan.statePath });

      const snapshot = await buildRuntimeSnapshot({
        cwd: rootDir,
        engine,
        store,
        validationResultCache: createEphemeralValidationResultCache(),
      });

      assert.equal(writes.length, 2);
      assert(writes[0].chunks.some((chunk) => chunk.vector.length === 0));
      assert(writes[1].chunks.every((chunk) => chunk.vector.length === 128));
      assert.equal(writes[0].index.embeddingStats?.reusedChunks, previous.chunks.length);
      assert.equal(writes[1].index.embeddingStats?.reusedChunks, 0);
      assert.equal(snapshot.semanticIndex.embeddingStats?.reusedChunks, 0);
      store.close();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

function nativeTestVector(seed: number): number[] {
  return Array.from({ length: 896 }, (_, index) => (index === 0 ? seed : 0));
}
