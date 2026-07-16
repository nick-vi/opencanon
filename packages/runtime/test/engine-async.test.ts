import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { loadEngine } from "@opencanon/engine";

test("native graph indexing keeps the event loop and project readers responsive", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-engine-async-"));
  mkdirSync(path.join(rootDir, "src"));
  const files = Array.from({ length: 400 }, (_, fileIndex) => {
    const file = `src/file-${fileIndex}.ts`;
    const content = Array.from(
      { length: 20 },
      (_, symbolIndex) => `export function symbol${fileIndex}_${symbolIndex}(value: number) { return value + ${symbolIndex}; }`,
    ).join("\n");
    writeFileSync(path.join(rootDir, file), content);
    return { path: file, contentHash: `hash-${fileIndex}`, language: "typescript" as const, content };
  });
  const project = loadEngine().openProject({
    rootDir,
    statePath: path.join(rootDir, "state.sqlite"),
    codeGraphStatePath: path.join(rootDir, "state.sqlite"),
    settings: {
      docsDir: "docs",
      conventionsPath: "opencanon/conventions.ts",
      fixturesDir: "opencanon/fixtures",
      projectFilePatterns: ["src/**/*.ts"],
      ignore: [],
      maxFiles: 20_000,
      maxFileSizeKb: 512,
      fileDiscovery: "filesystem",
      configHash: "async-index-test",
    },
  });
  project.scanAndDiff({ files: files.map((file) => file.path) });
  let timerTicks = 0;
  let successfulReads = 0;
  let successfulWrites = 0;
  let maxWriteLatencyMs = 0;
  const timer = setInterval(() => {
    timerTicks += 1;
    project.searchSymbols({ query: "symbol" });
    successfulReads += 1;
    const writeStartedAt = performance.now();
    project.writeEvent({
      id: `graph-index-heartbeat-${timerTicks}`,
      type: "indexed",
      timestamp: new Date().toISOString(),
      files: [],
      changeIds: [],
      taskIds: [],
      checkIds: [],
      conventionIds: [],
      validatorIds: [],
      findingIds: [],
      summary: "Graph indexing remained responsive.",
    });
    maxWriteLatencyMs = Math.max(maxWriteLatencyMs, performance.now() - writeStartedAt);
    successfulWrites += 1;
  }, 10);

  try {
    const result = await project.indexCodeGraph({ files, parserVersion: "async-index-test" });
    project.publishProjectState({
      revision: 2,
      codeGraphGeneration: result.generation,
      productModel: {
        indexedAt: "2026-07-16T14:00:00.000Z",
        graphHash: "async-index-test",
        definitionsHash: "async-index-test",
        counts: { areas: 0, specs: 0, changes: 0, conventions: 0, impactSurfaces: 0, validators: 0, nodes: 0, edges: 0, diagnostics: 0 },
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
          backlinks: { areaToSurfaces: {}, specToSurfaces: {}, changeToSurfaces: {}, surfaceToAreas: {}, surfaceToSpecs: {}, surfaceToChanges: {}, surfaceToConventions: {} },
        },
      },
      protocolEvent: {
        protocolVersion: 1,
        timestamp: "2026-07-16T14:00:00.000Z",
        revision: 2,
        domain: "project",
        type: "published",
        summary: "Published asynchronous graph index.",
        ids: [],
      },
      maxProtocolEventCount: 100,
      retainProtocolEventsAfter: "2026-07-01T00:00:00.000Z",
    });
    assert.equal(result.indexed.length, files.length);
    assert(timerTicks >= 2, `Expected the event loop to advance during graph indexing, received ${timerTicks} timer ticks.`);
    assert(successfulReads >= 2, `Expected concurrent project reads during graph indexing, received ${successfulReads}.`);
    assert(successfulWrites >= 2, `Expected concurrent Activity writes during graph indexing, received ${successfulWrites}.`);
    assert(maxWriteLatencyMs < 250, `Expected Activity writes below 250 ms, observed ${maxWriteLatencyMs.toFixed(1)} ms.`);
    assert.equal(project.searchSymbols({ query: "symbol42_3" }).symbols[0]?.name, "symbol42_3");
  } finally {
    clearInterval(timer);
    project.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
