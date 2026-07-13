import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { buildProjectSemanticIndex, buildProjectSemanticIndexDelta, buildRuntimeSnapshot, createKnowledgeIndexManager, createProjectStore, semanticIndexProducerVersion, semanticSearchVectorForProvider } from "@opencanon/runtime";
import { collectRuntimeKnowledgeChunks, knowledgeProducerIdentity } from "../src/knowledge-producers.ts";
import { captureRuntimeSourceSnapshot, snapshotFiles } from "../src/project-source-snapshot.ts";
import { cachedStartupSemanticIndexSnapshot } from "../src/semantic-index-snapshot.ts";
import { createEngine } from "@opencanon/engine";
import { createEphemeralValidationResultCache, createPaths, type FileFacts, type ScanAndDiffResult, type SemanticEmbeddingConfig, type SemanticIndexDiagnostic, type WriteSemanticIndexRequest } from "@opencanon/core";
import { createAuthoringProject } from "./support.ts";
import { admittedJobs, assignedJobEvent, emptyPruneResult } from "./engine-binding-test-support.ts";

test("runtime source snapshots feed captured bytes into fact extraction", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-source-snapshot-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", projectFilePatterns: ["src/**/*.ts"], ignore: [] }));
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = 'snapshot';\n");
    const paths = createPaths(rootDir);
    const extracted: Array<{ path: string; contentHash: string; content?: string }> = [];
    const store = {
      scanAndDiff(files: string[]) {
        return {
          statePath: path.join(rootDir, ".opencanon/state.sqlite"),
          schemaVersion: 6,
          inventoryHash: "inventory",
          files: files.map((file) => ({ path: file, contentHash: `scan:${file}`, size: 1, stale: false })),
          changedFiles: files,
          unchangedFiles: [],
          deletedFiles: [],
          staleFiles: 0,
        };
      },
      project: {
        extractFacts(request: { files: Array<{ path: string; contentHash: string; content?: string }> }) {
          extracted.push(...request.files);
          return { files: [], diagnostics: [] };
        },
      },
    };

    const snapshot = captureRuntimeSourceSnapshot({ rootDir, paths, store: store as never });

    const source = snapshot.fileSnapshots.find((file) => file.path === "src/company.ts");
    assert(source);
    assert.equal(source.content, "export const company = 'snapshot';\n");
    assert.match(source.contentHash, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(extracted[0]?.path, "src/company.ts");
    assert.equal(extracted[0]?.content, source.content);
    assert.equal(extracted[0]?.contentHash, source.contentHash);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime source snapshot capture handles large file inventories deterministically", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-source-snapshot-large-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const files = Array.from({ length: 1_200 }, (_value, index) => {
      const file = `src/file-${String(index).padStart(4, "0")}.ts`;
      writeFileSync(path.join(rootDir, file), `export const value${index} = ${index};\n`);
      return file;
    });

    const snapshots = snapshotFiles(rootDir, files.toReversed());

    assert.equal(snapshots.length, files.length);
    assert.deepEqual(snapshots.map((file) => file.path), files);
    assert(snapshots.every((file) => file.contentHash.startsWith("sha256:")));
    assert.equal(snapshots.reduce((total, file) => total + file.size, 0), files.reduce((total, file, index) => total + Buffer.byteLength(`export const value${index} = ${index};\n`), 0));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime semantic index chunks files with native vectors", () => {
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
      project: nativeTestProject(),
      semanticEmbedding: nativeEmbeddingConfig(),
    });

    assert.equal(build.index.id, "project");
    assert.equal(build.index.status, "ready");
    assert.equal(build.index.provider.dimensions, 896);
    assert.equal(build.index.provider.kind, "native");
    assert.equal(build.index.producerVersion, semanticIndexProducerVersion());
    assert.match(build.index.identityHash, /^[a-f0-9]{64}$/u);
    assert.equal(build.index.chunkTreeHash.length, 64);
    assert.equal(build.index.chunkCount, build.chunks.length);
    assert.deepEqual(build.index.embeddingStats, {
      totalChunks: 1,
      embeddedChunks: 1,
      reusedChunks: 0,
      filesScanned: 2,
      filesChanged: 1,
      filesDeleted: 0,
      chunksAdded: 1,
      chunksChanged: 0,
      chunksRemoved: 0,
      vectorsWritten: 1,
      vectorsReused: 0,
    });
    assert.equal(build.chunks.length, 1);
    const summary = build.chunks.find((chunk) => chunk.metadata.kind === "text");
    assert(summary);
    assert.equal(summary.metadata.path, "src/company.ts");
    assert.equal(summary.metadata.embeddingHash.length, 64);
    assert(summary.text.includes("Exports: function loadCompany"));
    assert.equal(summary.vector.length, 896);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Project Knowledge producers own markdown and typed fact chunking", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-knowledge-producers-"));
  try {
    mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "docs/guide.md"), "# Guide\n\nThis explains invoices and billing workflows.\n");
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = 'Acme';\n");
    const facts: FileFacts[] = [{
      path: "src/company.ts",
      contentHash: "ts-content",
      language: "typescript",
      parser: "oxc",
      parserVersion: "test",
      imports: [],
      exports: [{ line: 1, column: 1, name: "company", kind: "const" }],
      symbols: [{ line: 1, column: 14, name: "company", kind: "variable", exported: true, endLine: 1, params: [] }],
      declarations: [],
      calls: [],
      literals: [{ line: 1, column: 24, value: "Acme", valueKind: "string", context: "initializer" }],
      comments: [],
      references: [],
      annotations: [],
      diagnosticFacts: [],
      duplicates: [],
      diagnostics: [],
    }];
    const diagnostics: SemanticIndexDiagnostic[] = [];
    const chunks = collectRuntimeKnowledgeChunks({
      rootDir,
      scan: {
        statePath: path.join(rootDir, ".opencanon/state.sqlite"),
        schemaVersion: 6,
        inventoryHash: "inventory",
        files: [
          { path: "docs/guide.md", contentHash: "md-content", size: 52, stale: false },
          { path: "src/company.ts", contentHash: "ts-content", size: 31, stale: false },
          { path: "src/missing.ts", contentHash: "missing", size: 1, stale: false },
        ],
        changedFiles: ["docs/guide.md", "src/company.ts", "src/missing.ts"],
        unchangedFiles: [],
        deletedFiles: [],
        staleFiles: 0,
      },
      facts,
    }, diagnostics);

    assert(knowledgeProducerIdentity().includes("markdown:"));
    assert(knowledgeProducerIdentity().includes("typescript:"));
    assert(chunks.some((chunk) => chunk.metadata.path === "docs/guide.md" && chunk.metadata.kind === "section"));
    assert(chunks.some((chunk) => chunk.metadata.path === "src/company.ts" && chunk.text.includes("Exports: const company")));
    assert(diagnostics.some((diagnostic) => diagnostic.code === "semantic-no-structured-chunks" && diagnostic.path === "src/missing.ts"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime snapshot reports a missing reusable semantic index as stale", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-missing-"));
  try {
    createAuthoringProject(rootDir);
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/company.ts"), "export function loadCompany() {\n  return 'active company';\n}\n");
    const statePath = path.join(rootDir, ".opencanon/state.sqlite");
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
            statePath,
            schemaVersion: 6,
            migrationsApplied: [1],
            refresh: { status: "live", mode: "watch", bufferedEvents: 0 },
          }),
        scanAndDiffJson: (requestJson: string) => {
          const request = JSON.parse(requestJson) as { files: string[] };
          return JSON.stringify({
            statePath,
            schemaVersion: 6,
            inventoryHash: "inventory",
            files: request.files.map((file) => ({ path: file, contentHash: `hash:${file}`, size: 1, stale: false })),
            changedFiles: request.files,
            unchangedFiles: [],
            deletedFiles: [],
            staleFiles: 0,
          });
        },
        extractFactsJson: () => JSON.stringify({ files: [], diagnostics: [] }),
        indexCodeGraphJson: (requestJson: string) => {
          const request = JSON.parse(requestJson) as { files: Array<{ path: string }>; deletedFiles: string[]; parserVersion: string };
          return JSON.stringify({
            indexed: request.files.map((file) => ({ path: file.path, nodes: 0, unresolved: 0, supported: true })),
            deleted: request.deletedFiles,
            diagnostics: [],
            parserVersion: request.parserVersion,
            extractorVersion: "test",
          });
        },
        buildRepoGraphJson: () =>
          JSON.stringify({
            graph: { rootDir, graphHash: "graph", files: [] },
          }),
        searchSymbolsJson: () => JSON.stringify({ symbols: [] }),
        searchReferencesJson: () => JSON.stringify({ references: [] }),
        searchGraphEdgesJson: () => JSON.stringify({ edges: [] }),
        writeProductModelProjectionJson: () => undefined,
        readProductModelProjectionJson: () => JSON.stringify({ projection: null }),
        writeSemanticIndexJson: () => undefined,
        writeSemanticIndexDeltaJson: () => undefined,
        readSemanticIndexStatusJson: () => JSON.stringify({ index: null }),
        listSemanticChunksJson: () => JSON.stringify({ index: null, chunks: [] }),
        searchSemanticIndexJson: () => JSON.stringify({ index: null, results: [] }),
        embedSemanticTextsJson: (requestJson: string) => {
          const request = JSON.parse(requestJson) as { modelId: string; texts: string[] };
          return JSON.stringify({ modelId: request.modelId, dimensions: 896, vectors: request.texts.map((_text, index) => nativeTestVector(index + 1)) });
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
      }),
    });
    const store = createProjectStore({ rootDir, paths: createPaths(rootDir), engine });

    const snapshot = await buildRuntimeSnapshot({
      cwd: rootDir,
      engine,
      store,
      validationResultCache: createEphemeralValidationResultCache(),
    });

    assert.equal(snapshot.semanticIndex.status, "missing");
    assert.equal(snapshot.state.semanticIndex?.status, "missing");
    assert.equal(snapshot.semanticIndex.chunkCount, 0);
    assert(snapshot.semanticIndex.diagnostics.some((diagnostic) => diagnostic.code === "semantic-index-missing-on-startup"));
    store.close();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("startup Project Knowledge status is explicit about cached but unverified state", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-startup-status-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/company.ts"), "export function loadCompany() {\n  return 'active company';\n}\n");
    const previous = buildProjectSemanticIndex({
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
      }],
      project: nativeTestProject(),
      semanticEmbedding: nativeEmbeddingConfig(),
    }).index;
    const store = {
      readSemanticIndexStatus: () => ({ index: previous }),
    } as Pick<Parameters<typeof cachedStartupSemanticIndexSnapshot>[0], "readSemanticIndexStatus"> as Parameters<typeof cachedStartupSemanticIndexSnapshot>[0];
    const snapshot = cachedStartupSemanticIndexSnapshot(store, nativeEmbeddingConfig());

    assert.equal(snapshot.status, "stale");
    assert.equal(snapshot.staleChunkCount, previous.chunkCount);
    assert(snapshot.diagnostics.some((diagnostic) =>
      diagnostic.code === "semantic-index-unverified-on-startup" &&
      diagnostic.message.includes("available but has not been verified") &&
      diagnostic.message.includes("before relying on Search or Ask"),
    ));
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
      project: nativeTestProject(),
      semanticEmbedding: nativeEmbeddingConfig(),
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
      project: nativeTestProject(),
      semanticEmbedding: nativeEmbeddingConfig(),
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

test("runtime semantic index batches native document embeddings", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-batches-"));
  try {
    mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    const files = Array.from({ length: 300 }, (_, index) => {
      const file = `docs/topic-${index}.md`;
      writeFileSync(path.join(rootDir, file), `# Topic ${index}\n\nThis topic documents billing search behavior ${index}.\n`);
      return { path: file, contentHash: `topic-${index}`, size: 72, stale: false };
    });
    const calls: Array<{ task: string; texts: string[]; modelId: string }> = [];

    const build = buildProjectSemanticIndex({
      rootDir,
      scan: {
        statePath: path.join(rootDir, ".opencanon/state.sqlite"),
        schemaVersion: 6,
        inventoryHash: "inventory",
        files,
        changedFiles: files.map((file) => file.path),
        unchangedFiles: [],
        deletedFiles: [],
        staleFiles: 0,
      },
      facts: [],
      project: nativeTestProject({ calls }),
      semanticEmbedding: nativeEmbeddingConfig(),
    });

    assert.equal(build.index.status, "ready");
    assert.equal(build.chunks.length, 300);
    assert.equal(build.index.embeddingStats?.embeddedChunks, 300);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => call.texts.length), [128, 128, 44]);
    assert(build.chunks.every((chunk) => chunk.vector.length === 896));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime semantic index bounds code symbol chunks per file", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-code-cap-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const exportedNames = Array.from({ length: 24 }, (_, index) => `exported${index}`);
    const internalNames = Array.from({ length: 24 }, (_, index) => `internal${index}`);
    writeFileSync(
      path.join(rootDir, "src/large.ts"),
      [
        ...exportedNames.map((name) => `export function ${name}() { return "${name}"; }`),
        ...internalNames.map((name) => `function ${name}() { return "${name}"; }`),
      ].join("\n"),
    );
    const symbols = [
      ...exportedNames.map((name, index) => ({ line: index + 1, column: 17, name, kind: "function" as const, exported: true, endLine: index + 1, params: [] })),
      ...internalNames.map((name, index) => ({ line: exportedNames.length + index + 1, column: 10, name, kind: "function" as const, exported: false, endLine: exportedNames.length + index + 1, params: [] })),
    ];

    const build = buildProjectSemanticIndex({
      rootDir,
      scan: {
        statePath: path.join(rootDir, ".opencanon/state.sqlite"),
        schemaVersion: 6,
        inventoryHash: "inventory",
        files: [{ path: "src/large.ts", contentHash: "large", size: 2_000, stale: false }],
        changedFiles: ["src/large.ts"],
        unchangedFiles: [],
        deletedFiles: [],
        staleFiles: 0,
      },
      facts: [{
        path: "src/large.ts",
        contentHash: "large",
        language: "typescript",
        parser: "oxc",
        parserVersion: "test",
        imports: [],
        exports: exportedNames.map((name, index) => ({ line: index + 1, column: 1, name, kind: "function" })),
        symbols,
        declarations: [],
        calls: [],
        literals: [],
        comments: [],
        references: [],
        annotations: [],
        diagnosticFacts: [],
        duplicates: [],
        diagnostics: [],
      }],
      project: nativeTestProject(),
      semanticEmbedding: nativeEmbeddingConfig(),
    });

    assert.equal(build.index.status, "ready");
    assert.equal(build.chunks.length, 1);
    assert.equal(build.chunks.filter((chunk) => chunk.metadata.kind === "text").length, 1);
    assert(build.chunks[0].text.includes("Exports: function exported0"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime snapshot reports missing semantic index with project embedding config without rebuilding", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-config-"));
  try {
    createAuthoringProject(rootDir);
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify(
        {
          conventionsPath: "conventions/index.ts",
          fixturesDir: "fixtures",
          fileDiscovery: "filesystem",
          projectFilePatterns: ["src/**/*.ts"],
          ignore: ["node_modules/**", ".opencanon/**"],
          semanticEmbedding: {
            mode: "native",
            modelId: "jina-code-v2",
            showDownloadProgress: false,
          },
        },
        null,
        2,
      ),
    );
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/company.ts"), "export function loadCompany() {\n  return 'active company';\n}\n");
    const scan: ScanAndDiffResult = {
      statePath: path.join(rootDir, ".opencanon/state.sqlite"),
      schemaVersion: 6,
      inventoryHash: "inventory",
      files: [{ path: "src/company.ts", contentHash: "content", size: 64, stale: false }],
      changedFiles: ["src/company.ts"],
      unchangedFiles: [],
      deletedFiles: [],
      staleFiles: 0,
    };
    const facts: FileFacts[] = [{
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
    }];
    const writes: WriteSemanticIndexRequest[] = [];
    const embedCalls: Array<{ modelId: string; texts: string[]; task?: string }> = [];
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
          writes.push(JSON.parse(requestJson) as WriteSemanticIndexRequest);
        },
        writeSemanticIndexDeltaJson: () => undefined,
        readSemanticIndexStatusJson: () => JSON.stringify({ index: writes.at(-1)?.index ?? null }),
        listSemanticChunksJson: () => JSON.stringify({ index: writes.at(-1)?.index ?? null, chunks: writes.at(-1)?.chunks.map((chunk) => chunk.metadata) ?? [] }),
        searchSemanticIndexJson: () => JSON.stringify({ index: null, results: [] }),
        embedSemanticTextsJson: (requestJson: string) => {
          const request = JSON.parse(requestJson) as { modelId: string; texts: string[]; task?: string };
          embedCalls.push(request);
          return JSON.stringify({ modelId: request.modelId, dimensions: 896, vectors: request.texts.map((_text, index) => nativeTestVector(index + 1)) });
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
      }),
    });
    const store = createProjectStore({ rootDir, paths: createPaths(rootDir), engine, statePath: scan.statePath });

    const snapshot = await buildRuntimeSnapshot({
      cwd: rootDir,
      engine,
      store,
      validationResultCache: createEphemeralValidationResultCache(),
    });

    assert.equal(writes.length, 0);
    assert.equal(embedCalls.length, 0);
    assert.equal(snapshot.semanticIndex.status, "missing");
    assert.equal(snapshot.semanticIndex.provider.kind, "native");
    assert.equal(snapshot.semanticIndex.provider.modelId, "jina-code-v2");
    assert(snapshot.semanticIndex.diagnostics.some((diagnostic) => diagnostic.code === "semantic-index-missing-on-startup"));
    store.close();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("semantic index fails invalid embedding config without local vector output", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-invalid-config-"));
  try {
    writeFileSync(path.join(rootDir, "README.md"), "# Company\n\nThe company search surface.\n");
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
      semanticEmbedding: {
        mode: "remote" as never,
        modelId: "jina-code-v2",
        showDownloadProgress: false,
      },
    });

    assert.equal(build.index.status, "failed");
    assert.equal(build.chunks.length, 0);
    assert(build.index.diagnostics.some((diagnostic) => diagnostic.code === "semantic-embedding-config-invalid" && diagnostic.severity === "error"));
    assert(!build.index.diagnostics.some((diagnostic) => diagnostic.message.includes("using local")));
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
      filesScanned: 2,
      filesChanged: 2,
      filesDeleted: 0,
      chunksAdded: 2,
      chunksChanged: 0,
      chunksRemoved: 0,
      vectorsWritten: 2,
      vectorsReused: 0,
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
      filesScanned: 2,
      filesChanged: 1,
      filesDeleted: 0,
      chunksAdded: 2,
      chunksChanged: 0,
      chunksRemoved: 0,
      vectorsWritten: 1,
      vectorsReused: 1,
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
    const previous = buildProjectSemanticIndex({
      rootDir,
      scan: previousScan,
      facts,
      project: nativeTestProject(),
      semanticEmbedding: nativeEmbeddingConfig(),
    });
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
        writeSemanticIndexDeltaJson: () => undefined,
        readSemanticIndexStatusJson: () => JSON.stringify({ index: previous.index }),
        listSemanticChunksJson: () => JSON.stringify({ index: previous.index, chunks: previous.chunks.map((chunk) => chunk.metadata) }),
        searchSemanticIndexJson: () => JSON.stringify({ index: null, results: [] }),
        embedSemanticTextsJson: (requestJson: string) => {
          const request = JSON.parse(requestJson) as { modelId: string; texts: string[] };
          return JSON.stringify({ modelId: request.modelId, dimensions: 896, vectors: request.texts.map((_text, index) => nativeTestVector(index + 1)) });
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
      }),
    });
    const store = createProjectStore({ rootDir, paths: createPaths(rootDir), engine, statePath: nextScan.statePath });

    const snapshot = await buildRuntimeSnapshot({
      cwd: rootDir,
      engine,
      store,
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

test("runtime snapshot marks cached semantic index stale after provider config changes without resetting state", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-provider-change-"));
  try {
    createAuthoringProject(rootDir);
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/company.ts"), "export function loadCompany() {\n  return 'active company';\n}\n");
    const scan: ScanAndDiffResult = {
      statePath: path.join(rootDir, ".opencanon/state.sqlite"),
      schemaVersion: 6,
      inventoryHash: "inventory",
      files: [{ path: "src/company.ts", contentHash: "content", size: 64, stale: false }],
      changedFiles: ["src/company.ts"],
      unchangedFiles: [],
      deletedFiles: [],
      staleFiles: 0,
    };
    const facts: FileFacts[] = [{
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
    }];
    const previous = buildProjectSemanticIndex({
      rootDir,
      scan,
      facts,
      project: nativeTestProject({ dimensions: 1536 }),
      semanticEmbedding: nativeEmbeddingConfig("jina-code-v2-large"),
    });
    assert.equal(previous.index.provider.kind, "native");
    assert.equal(previous.index.provider.modelId, "jina-code-v2-large");
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify(
        {
          conventionsPath: "conventions/index.ts",
          fixturesDir: "fixtures",
          fileDiscovery: "filesystem",
          projectFilePatterns: ["src/**/*.ts"],
          ignore: ["node_modules/**", ".opencanon/**"],
          semanticEmbedding: {
            mode: "native",
            modelId: "jina-code-v2",
            showDownloadProgress: false,
          },
        },
        null,
        2,
      ),
    );
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
          writes.push(JSON.parse(requestJson) as WriteSemanticIndexRequest);
        },
        writeSemanticIndexDeltaJson: () => undefined,
        readSemanticIndexStatusJson: () => JSON.stringify({ index: writes.at(-1)?.index ?? previous.index }),
        listSemanticChunksJson: () => {
          const latest = writes.at(-1);
          return JSON.stringify({ index: latest?.index ?? previous.index, chunks: latest ? latest.chunks.map((chunk) => chunk.metadata) : previous.chunks.map((chunk) => chunk.metadata) });
        },
        searchSemanticIndexJson: () => JSON.stringify({ index: null, results: [] }),
        embedSemanticTextsJson: (requestJson: string) => {
          const request = JSON.parse(requestJson) as { modelId: string; texts: string[] };
          return JSON.stringify({ modelId: request.modelId, dimensions: 896, vectors: request.texts.map((_text, index) => nativeTestVector(index + 1)) });
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
      }),
    });
    const store = createProjectStore({ rootDir, paths: createPaths(rootDir), engine, statePath: scan.statePath });

    const snapshot = await buildRuntimeSnapshot({
      cwd: rootDir,
      engine,
      store,
      validationResultCache: createEphemeralValidationResultCache(),
    });

    assert.equal(writes.length, 0);
    assert.equal(snapshot.semanticIndex.status, "missing");
    assert.equal(snapshot.semanticIndex.provider.modelId, "jina-code-v2");
    assert.equal(snapshot.semanticIndex.chunkCount, 0);
    assert.equal(snapshot.semanticIndex.vectorCount, 0);
    assert.equal(snapshot.semanticIndex.staleChunkCount, 0);
    assert(snapshot.semanticIndex.diagnostics.some((diagnostic) => diagnostic.code === "semantic-index-provider-changed"));
    store.close();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("semantic index delta embeds zero chunks for a warm no-op inventory", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-delta-noop-"));
  try {
    writeFileSync(path.join(rootDir, "README.md"), "# Company\n\nThe company search surface.\n");
    const scan: ScanAndDiffResult = {
      statePath: path.join(rootDir, ".opencanon/state.sqlite"),
      schemaVersion: 6,
      inventoryHash: "inventory",
      files: [{ path: "README.md", contentHash: "readme", size: 40, stale: false }],
      changedFiles: ["README.md"],
      unchangedFiles: [],
      deletedFiles: [],
      staleFiles: 0,
    };
    const previous = buildProjectSemanticIndex({
      rootDir,
      scan,
      facts: [],
      project: nativeTestProject(),
      semanticEmbedding: nativeEmbeddingConfig(),
    });
    const calls: Array<{ task: string; texts: string[]; modelId: string }> = [];
    const delta = buildProjectSemanticIndexDelta({
      rootDir,
      scan: {
        ...scan,
        changedFiles: [],
        unchangedFiles: ["README.md"],
      },
      facts: [],
      project: nativeTestProject({ calls }),
      semanticEmbedding: nativeEmbeddingConfig(),
      previousIndex: previous.index,
      previousChunks: previous.chunks.map((chunk) => chunk.metadata),
    });

    assert.equal(delta.index.status, "ready");
    assert.equal(delta.chunks?.length ?? 0, 0);
    assert.equal(delta.index.embeddingStats?.embeddedChunks, 0);
    assert.equal(delta.index.embeddingStats?.reusedChunks, previous.chunks.length);
    assert.equal(delta.index.embeddingStats?.filesScanned, 1);
    assert.equal(delta.index.embeddingStats?.filesChanged, 0);
    assert.equal(delta.index.embeddingStats?.filesDeleted, 0);
    assert.equal(delta.index.embeddingStats?.chunksChanged, 0);
    assert.equal(delta.index.embeddingStats?.chunksRemoved, 0);
    assert.equal(delta.index.embeddingStats?.vectorsWritten, 0);
    assert.equal(delta.index.embeddingStats?.vectorsReused, previous.chunks.length);
    assert.deepEqual(delta.removedPaths ?? [], []);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("semantic index delta embeds only changed file chunks", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-delta-one-file-"));
  try {
    mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    writeFileSync(path.join(rootDir, "README.md"), "# Company\n\nThe company search surface.\n");
    writeFileSync(path.join(rootDir, "docs/inventory.md"), "# Inventory\n\nThe original inventory workflow.\n");
    const initialScan: ScanAndDiffResult = {
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
    };
    const previous = buildProjectSemanticIndex({
      rootDir,
      scan: initialScan,
      facts: [],
      project: nativeTestProject(),
      semanticEmbedding: nativeEmbeddingConfig(),
    });
    writeFileSync(path.join(rootDir, "docs/inventory.md"), "# Inventory\n\nThe updated inventory workflow adds supplier review.\n");
    const calls: Array<{ task: string; texts: string[]; modelId: string }> = [];
    const delta = buildProjectSemanticIndexDelta({
      rootDir,
      scan: {
        ...initialScan,
        inventoryHash: "inventory-two",
        files: [
          { path: "README.md", contentHash: "readme-one", size: 40, stale: false },
          { path: "docs/inventory.md", contentHash: "inventory-two", size: 64, stale: false },
        ],
        changedFiles: ["docs/inventory.md"],
        unchangedFiles: ["README.md"],
      },
      facts: [],
      project: nativeTestProject({ calls }),
      semanticEmbedding: nativeEmbeddingConfig(),
      previousIndex: previous.index,
      previousChunks: previous.chunks.map((chunk) => chunk.metadata),
    });

    assert.equal(delta.index.status, "ready");
    assert.equal(delta.chunks?.length ?? 0, 1);
    assert.equal(delta.chunks?.[0]?.metadata.path, "docs/inventory.md");
    assert.deepEqual(delta.removedPaths ?? [], ["docs/inventory.md"]);
    assert.equal(delta.index.embeddingStats?.embeddedChunks, 1);
    assert.equal(delta.index.embeddingStats?.reusedChunks, previous.chunks.length - 1);
    assert.equal(delta.index.embeddingStats?.filesScanned, 2);
    assert.equal(delta.index.embeddingStats?.filesChanged, 1);
    assert.equal(delta.index.embeddingStats?.filesDeleted, 0);
    assert.equal(delta.index.embeddingStats?.chunksAdded, 0);
    assert.equal(delta.index.embeddingStats?.chunksChanged, 1);
    assert.equal(delta.index.embeddingStats?.chunksRemoved, 1);
    assert.equal(delta.index.embeddingStats?.vectorsWritten, 1);
    assert.equal(delta.index.embeddingStats?.vectorsReused, previous.chunks.length - 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].texts.length, 1);
    assert(calls[0].texts[0].includes("supplier review"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("KnowledgeIndexManager rebuilds stale vector state with a full index", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-manager-full-"));
  try {
    createAuthoringProject(rootDir);
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/company.ts"), "export function loadCompany() {\n  return 'active company';\n}\n");
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify(
        {
          conventionsPath: "conventions/index.ts",
          fixturesDir: "fixtures",
          fileDiscovery: "filesystem",
          projectFilePatterns: ["src/**/*.ts"],
          ignore: ["node_modules/**", ".opencanon/**"],
          semanticEmbedding: {
            mode: "native",
            modelId: "jina-code-v2",
            showDownloadProgress: false,
          },
        },
        null,
        2,
      ),
    );
    const scan: ScanAndDiffResult = {
      statePath: path.join(rootDir, ".opencanon/state.sqlite"),
      schemaVersion: 6,
      inventoryHash: "inventory",
      files: [{ path: "src/company.ts", contentHash: "content", size: 64, stale: false }],
      changedFiles: ["src/company.ts"],
      unchangedFiles: [],
      deletedFiles: [],
      staleFiles: 0,
    };
    const facts: FileFacts[] = [{
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
    }];
    const writes: WriteSemanticIndexRequest[] = [];
    const staleIndex = {
      id: "project",
      version: "semantic-index-v2",
      status: "stale",
      provider: {
        id: "opencanon-native-jina-code-v2",
        kind: "native",
        modelId: "jina-code-v2",
        modelDigest: "digest",
        dimensions: 896,
        distance: "cosine",
        configHash: "config",
      },
      chunkerVersion: "chunker",
      producerVersion: "producer",
      sourceInventoryHash: "stale-inventory",
      chunkTreeHash: "stale-tree",
      identityHash: "stale-identity",
      chunkCount: 1,
      vectorCount: 0,
      staleChunkCount: 1,
      indexedAt: "2026-06-06T00:00:00.000Z",
      diagnostics: [{ code: "semantic-vector-rebuild-required", message: "Rebuild required.", severity: "warning" }],
    };
    const embedCalls: Array<{ task?: string; texts: string[]; modelId: string }> = [];
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
        buildRepoGraphJson: () => JSON.stringify({ graph: { rootDir, graphHash: "graph", files: scan.files.map((file) => file.path), packages: [], importEdges: [] } }),
        indexCodeGraphJson: () => JSON.stringify({ indexed: [], deleted: [], diagnostics: [], parserVersion: "oxc-test", extractorVersion: "graph-test" }),
        searchSymbolsJson: () => JSON.stringify({ symbols: [] }),
        searchReferencesJson: () => JSON.stringify({ references: [] }),
        searchGraphEdgesJson: () => JSON.stringify({ edges: [] }),
        writeProductModelProjectionJson: () => undefined,
        readProductModelProjectionJson: () => JSON.stringify({ projection: null }),
        writeSemanticIndexJson: (requestJson: string) => {
          writes.push(JSON.parse(requestJson) as WriteSemanticIndexRequest);
        },
        writeSemanticIndexDeltaJson: () => {
          throw new Error("stale vector state must not receive a delta write");
        },
        readSemanticIndexStatusJson: () => JSON.stringify({ index: writes.at(-1)?.index ?? staleIndex }),
        listSemanticChunksJson: () => {
          if (writes.length === 0) throw new Error("stale vector chunks must not be reused");
          return JSON.stringify({ index: writes.at(-1)?.index ?? null, chunks: writes.at(-1)?.chunks.map((chunk) => chunk.metadata) ?? [] });
        },
        searchSemanticIndexJson: () => JSON.stringify({ index: null, results: [] }),
        embedSemanticTextsJson: (requestJson: string) => {
          const request = JSON.parse(requestJson) as { modelId: string; texts: string[]; task?: string };
          embedCalls.push(request);
          return JSON.stringify({ modelId: request.modelId, dimensions: 896, vectors: request.texts.map((_text, index) => nativeTestVector(index + 1)) });
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
      }),
    });
    const store = createProjectStore({ rootDir, paths: createPaths(rootDir), engine, statePath: scan.statePath });
    const progress: string[] = [];
    const manager = createKnowledgeIndexManager({ rootDir, store });

    const result = await manager.index({ onProgress: (event) => progress.push(event.phase) });

    assert.equal(result.mode, "full");
    assert.equal(result.index.status, "ready");
    assert.equal(writes.length, 1);
    assert((writes[0].nodes ?? []).some((node) => node.kind === "root"));
    assert(embedCalls.some((call) => call.task === "document"));
    assert(embedCalls.some((call) => call.task === "query" && call.texts[0] === "Project Knowledge"));
    assert.deepEqual(progress, ["scan", "diff", "chunk", "embed", "write", "prewarm", "ready"]);
    store.close();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "duplicate vector ids", message: "ID already exists: chunk:stale-vector" },
  { name: "missing reused vectors", message: "Semantic chunk chunk:stale-vector cannot reuse a missing or changed vector." },
] as const) {
  test(`KnowledgeIndexManager fails fast after ${scenario.name}`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-semantic-manager-failfast-"));
    try {
      createAuthoringProject(rootDir);
      mkdirSync(path.join(rootDir, "src"), { recursive: true });
      writeFileSync(path.join(rootDir, "src/company.ts"), "export function loadCompany() {\n  return 'active company';\n}\n");
      writeFileSync(
        path.join(rootDir, "opencanon.config.json"),
        JSON.stringify(
          {
            conventionsPath: "conventions/index.ts",
            fixturesDir: "fixtures",
            fileDiscovery: "filesystem",
            projectFilePatterns: ["src/**/*.ts"],
            ignore: ["node_modules/**", ".opencanon/**"],
            semanticEmbedding: {
              mode: "native",
              modelId: "jina-code-v2",
              showDownloadProgress: false,
            },
          },
          null,
          2,
        ),
      );
      const scan: ScanAndDiffResult = {
        statePath: path.join(rootDir, ".opencanon/state.sqlite"),
        schemaVersion: 6,
        inventoryHash: "inventory",
        files: [{ path: "src/company.ts", contentHash: "content", size: 64, stale: false }],
        changedFiles: ["src/company.ts"],
        unchangedFiles: [],
        deletedFiles: [],
        staleFiles: 0,
      };
      const facts: FileFacts[] = [{
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
      }];
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
          buildRepoGraphJson: () => JSON.stringify({ graph: { rootDir, graphHash: "graph", files: scan.files.map((file) => file.path), packages: [], importEdges: [] } }),
          indexCodeGraphJson: () => JSON.stringify({ indexed: [], deleted: [], diagnostics: [], parserVersion: "oxc-test", extractorVersion: "graph-test" }),
          searchSymbolsJson: () => JSON.stringify({ symbols: [] }),
          searchReferencesJson: () => JSON.stringify({ references: [] }),
          searchGraphEdgesJson: () => JSON.stringify({ edges: [] }),
          writeProductModelProjectionJson: () => undefined,
          readProductModelProjectionJson: () => JSON.stringify({ projection: null }),
          writeSemanticIndexJson: (requestJson: string) => {
            writes.push(JSON.parse(requestJson) as WriteSemanticIndexRequest);
            throw new Error(scenario.message);
          },
          writeSemanticIndexDeltaJson: () => undefined,
          readSemanticIndexStatusJson: () => JSON.stringify({ index: null }),
          listSemanticChunksJson: () => JSON.stringify({ index: null, chunks: [] }),
          searchSemanticIndexJson: () => JSON.stringify({ index: null, results: [] }),
          embedSemanticTextsJson: (requestJson: string) => {
            const request = JSON.parse(requestJson) as { modelId: string; texts: string[] };
            return JSON.stringify({ modelId: request.modelId, dimensions: 896, vectors: request.texts.map((_text, index) => nativeTestVector(index + 1)) });
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
        }),
      });
      const store = createProjectStore({ rootDir, paths: createPaths(rootDir), engine, statePath: scan.statePath });
      const manager = createKnowledgeIndexManager({ rootDir, store });

      await assert.rejects(() => manager.index(), new RegExp(scenario.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(writes.length, 1);
      assert(writes[0].chunks.every((chunk) => chunk.vector.length === 896));
      store.close();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

function nativeEmbeddingConfig(modelId: SemanticEmbeddingConfig["modelId"] = "jina-code-v2"): SemanticEmbeddingConfig {
  return {
    mode: "native",
    modelId,
    showDownloadProgress: false,
  };
}

function nativeTestProject(input: { dimensions?: number; calls?: Array<{ task: string; texts: string[]; modelId: string }> } = {}) {
  const dimensions = input.dimensions ?? 896;
  return {
    embedSemanticTexts(request: { task?: string; texts: string[]; modelId: string }) {
      input.calls?.push({ task: request.task ?? "document", texts: request.texts, modelId: request.modelId });
      return {
        modelId: request.modelId,
        dimensions,
        vectors: request.texts.map((_text, index) => nativeTestVector(index + 1, dimensions)),
      };
    },
  } as never;
}

function nativeTestVector(seed: number, dimensions = 896): number[] {
  return Array.from({ length: dimensions }, (_, index) => (index === 0 ? seed : 0));
}
