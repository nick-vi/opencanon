import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { runProjectAnalysisOperation } from "../src/project-analysis-operation.ts";
import { parseProjectAnalysisResult, ProjectAnalysisProtocolVersion } from "../src/project-analysis-protocol.ts";
import { projectAnalysisStatePath } from "../src/service-namespace.ts";
import { createAuthoringProject } from "./support.ts";

test("project analysis worker returns a complete snapshot from isolated generated state", async () => {
  const rootDir = createProject();
  try {
    const analysisStatePath = path.join(rootDir, ".opencanon/cache/analysis.sqlite");
    const servingStatePath = path.join(rootDir, ".opencanon/cache/state.sqlite");
    const { snapshot, publication } = await runProjectAnalysisOperation({
      rootDir,
      analysisStatePath,
    });
    assert(snapshot.files.includes("src/index.ts"));
    assert.equal(snapshot.state.files, 1);
    assert.equal(typeof snapshot.health.engine.engineVersion, "string");
    assert(snapshot.facts.some((file) => file.path === "src/index.ts"));
    assert.equal(typeof publication.sourceInventoryHash, "string");
    assert.equal(publication.changeCatalog.rootDir, rootDir);
    assert.equal(publication.changeCatalog.changesPath, path.join(rootDir, "opencanon/changes/index.ts"));
    assert.equal(existsSync(analysisStatePath), true);
    assert.equal(existsSync(servingStatePath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project analysis cancellation waits for worker teardown", async () => {
  const rootDir = createProject(600);
  const controller = new AbortController();
  try {
    const operation = runProjectAnalysisOperation({
      rootDir,
      analysisStatePath: path.join(rootDir, ".opencanon/cache/analysis.sqlite"),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(operation, /superseded/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project analysis protocol rejects stale and malformed results", () => {
  assert.throws(() => parseProjectAnalysisResult(null, "request"), /invalid result/);
  assert.throws(
    () => parseProjectAnalysisResult({ version: ProjectAnalysisProtocolVersion + 1, requestId: "request", analysis: {} }, "request"),
    /protocol mismatch/,
  );
  assert.throws(
    () => parseProjectAnalysisResult({ version: ProjectAnalysisProtocolVersion, requestId: "other", analysis: {} }, "request"),
    /another request/,
  );
  assert.throws(
    () => parseProjectAnalysisResult({ version: ProjectAnalysisProtocolVersion, requestId: "request", analysis: { snapshot: {}, publication: {} } }, "request"),
    /invalid code graph generation/,
  );
  assert.throws(
    () => parseProjectAnalysisResult({
      version: ProjectAnalysisProtocolVersion,
      requestId: "request",
      analysis: { snapshot: {}, publication: { codeGraphGeneration: "next", sourceInventoryHash: "inventory", productModel: {} } },
    }, "request"),
    /no Change catalog/,
  );
});

test("analysis state is a sibling writer domain of serving state", () => {
  assert.equal(
    projectAnalysisStatePath("/repo/.opencanon/state/test/state.sqlite"),
    path.resolve("/repo/.opencanon/state/test/analysis.sqlite"),
  );
});

function createProject(extraFiles = 0): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-project-analysis-test-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/index.ts"), "export const ready = true;\n");
  for (let index = 0; index < extraFiles; index += 1) {
    writeFileSync(path.join(rootDir, `src/file-${index}.ts`), `export const value${index} = ${index};\n`);
  }
  return rootDir;
}
