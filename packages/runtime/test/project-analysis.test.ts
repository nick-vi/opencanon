import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { runProjectAnalysisOperation } from "../src/project-analysis-operation.ts";
import { parseProjectAnalysisResult, ProjectAnalysisProtocolVersion } from "../src/project-analysis-protocol.ts";
import { projectAnalysisStatePath } from "../src/service-namespace.ts";
import { RuntimeAnalysisOutcomeKind } from "../src/snapshot.ts";
import { createAuthoringProject } from "./support.ts";

test("project analysis worker returns a complete snapshot from isolated generated state", async () => {
  const rootDir = createProject();
  try {
    const analysisStatePath = path.join(rootDir, ".opencanon/cache/analysis.sqlite");
    const servingStatePath = path.join(rootDir, ".opencanon/cache/state.sqlite");
    const outcome = await runProjectAnalysisOperation({
      rootDir,
      analysisStatePath,
      codeGraphStatePath: analysisStatePath,
    });
    assert.equal(outcome.kind, RuntimeAnalysisOutcomeKind.Candidate);
    if (outcome.kind !== RuntimeAnalysisOutcomeKind.Candidate) throw new Error("Expected a project analysis candidate.");
    const { snapshot, publication } = outcome.analysis;
    assert(snapshot.files.includes("src/index.ts"));
    assert.equal(snapshot.state.files, 1);
    assert.equal(typeof snapshot.health.engine.engineVersion, "string");
    assert(snapshot.facts.some((file) => file.path === "src/index.ts"));
    assert.equal(typeof publication.analysisInputHash, "string");
    assert.equal(typeof publication.sourceInventoryHash, "string");
    assert.equal(publication.changeCatalog.rootDir, rootDir);
    assert.equal(publication.changeCatalog.changesPath, path.join(rootDir, "opencanon/changes/index.ts"));
    assert.equal(existsSync(analysisStatePath), true);
    assert.equal(existsSync(servingStatePath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project analysis returns unchanged before graph and validation work when source identity matches", async () => {
  const rootDir = createProject();
  try {
    const analysisStatePath = path.join(rootDir, ".opencanon/cache/analysis.sqlite");
    const first = await runProjectAnalysisOperation({ rootDir, analysisStatePath, codeGraphStatePath: analysisStatePath });
    assert.equal(first.kind, RuntimeAnalysisOutcomeKind.Candidate);
    if (first.kind !== RuntimeAnalysisOutcomeKind.Candidate) throw new Error("Expected an initial project analysis candidate.");
    const graphDir = path.join(path.dirname(analysisStatePath), "code-graph");
    const graphFilesBefore = readdirSync(graphDir).sort();

    const second = await runProjectAnalysisOperation({
      rootDir,
      analysisStatePath,
      codeGraphStatePath: analysisStatePath,
      previousAnalysisInputHash: first.analysis.publication.analysisInputHash,
    });

    assert.deepEqual(second, {
      kind: RuntimeAnalysisOutcomeKind.Unchanged,
      analysisInputHash: first.analysis.publication.analysisInputHash,
      sourceInventoryHash: first.analysis.publication.sourceInventoryHash,
    });
    assert.deepEqual(
      readdirSync(graphDir).filter((file) => !graphFilesBefore.includes(file)),
      [],
      "unchanged analysis must not stage a new graph generation",
    );

    writeFileSync(path.join(rootDir, "src/index.ts"), "export const ready = false;\n");
    const third = await runProjectAnalysisOperation({
      rootDir,
      analysisStatePath,
      codeGraphStatePath: analysisStatePath,
      previousAnalysisInputHash: first.analysis.publication.analysisInputHash,
    });
    assert.equal(third.kind, RuntimeAnalysisOutcomeKind.Candidate);
    if (third.kind !== RuntimeAnalysisOutcomeKind.Candidate) throw new Error("Expected changed source to produce an analysis candidate.");
    assert.notEqual(third.analysis.publication.sourceInventoryHash, first.analysis.publication.sourceInventoryHash);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project analysis treats imported canon changes as analysis input changes", async () => {
  const rootDir = createProject();
  const analysisStatePath = path.join(rootDir, ".opencanon/cache/analysis.sqlite");
  const helperPath = path.join(rootDir, "canon-helper.ts");
  writeFileSync(path.join(rootDir, "conventions/index.ts"), conventionSource());
  writeFileSync(helperPath, 'export const conventionIds = ["first-rule"];\n');
  try {
    const first = await runProjectAnalysisOperation({ rootDir, analysisStatePath, codeGraphStatePath: analysisStatePath });
    assert.equal(first.kind, RuntimeAnalysisOutcomeKind.Candidate);
    if (first.kind !== RuntimeAnalysisOutcomeKind.Candidate) throw new Error("Expected an initial project analysis candidate.");

    writeFileSync(helperPath, 'export const conventionIds = ["first-rule", "second-rule"];\n');
    const second = await runProjectAnalysisOperation({
      rootDir,
      analysisStatePath,
      codeGraphStatePath: analysisStatePath,
      previousAnalysisInputHash: first.analysis.publication.analysisInputHash,
    });

    assert.equal(second.kind, RuntimeAnalysisOutcomeKind.Candidate);
    if (second.kind !== RuntimeAnalysisOutcomeKind.Candidate) throw new Error("Expected changed canon to produce an analysis candidate.");
    assert.equal(second.analysis.publication.sourceInventoryHash, first.analysis.publication.sourceInventoryHash);
    assert.notEqual(second.analysis.publication.analysisInputHash, first.analysis.publication.analysisInputHash);
    assert.deepEqual(second.analysis.snapshot.validators.map((validator) => validator.id), ["first-rule", "second-rule"]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project analysis cancellation waits for worker teardown", async () => {
  const rootDir = createProject(600);
  const controller = new AbortController();
  const analysisStatePath = path.join(rootDir, ".opencanon/cache/analysis.sqlite");
  try {
    const operation = runProjectAnalysisOperation({
      rootDir,
      analysisStatePath,
      codeGraphStatePath: analysisStatePath,
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
    () => parseProjectAnalysisResult({ version: ProjectAnalysisProtocolVersion + 1, requestId: "request", outcome: {} }, "request"),
    /protocol mismatch/,
  );
  assert.throws(
    () => parseProjectAnalysisResult({ version: ProjectAnalysisProtocolVersion, requestId: "other", outcome: {} }, "request"),
    /another request/,
  );
  assert.throws(
    () => parseProjectAnalysisResult({
      version: ProjectAnalysisProtocolVersion,
      requestId: "request",
      outcome: { kind: RuntimeAnalysisOutcomeKind.Candidate, analysis: { snapshot: {}, publication: {} } },
    }, "request"),
    /invalid code graph generation/,
  );
  assert.throws(
    () => parseProjectAnalysisResult({
      version: ProjectAnalysisProtocolVersion,
      requestId: "request",
      outcome: {
        kind: RuntimeAnalysisOutcomeKind.Candidate,
        analysis: { snapshot: {}, publication: { codeGraphGeneration: "next", analysisInputHash: "input", sourceInventoryHash: "inventory", productModel: {} } },
      },
    }, "request"),
    /no Change catalog/,
  );
  assert.throws(
    () => parseProjectAnalysisResult({
      version: ProjectAnalysisProtocolVersion,
      requestId: "request",
      outcome: { kind: RuntimeAnalysisOutcomeKind.Unchanged, analysisInputHash: "input", sourceInventoryHash: "" },
    }, "request"),
    /no unchanged source inventory identity/,
  );
  assert.deepEqual(
    parseProjectAnalysisResult({
      version: ProjectAnalysisProtocolVersion,
      requestId: "request",
      outcome: { kind: RuntimeAnalysisOutcomeKind.Unchanged, analysisInputHash: "input", sourceInventoryHash: "inventory" },
    }, "request").outcome,
    { kind: RuntimeAnalysisOutcomeKind.Unchanged, analysisInputHash: "input", sourceInventoryHash: "inventory" },
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

function conventionSource(): string {
  return [
    'import { defineConvention } from "@opencanon/core";',
    'import { conventionIds } from "../canon-helper.ts";',
    "",
    "export default conventionIds.map((id) => defineConvention({",
    "  id,",
    "  title: id,",
    '  topics: ["test"],',
    "  rule: id,",
    '  applies: { kind: "files", globs: ["src/**/*.ts"] },',
    '  render: { kind: "none" },',
    '  runtime: { kind: "validator", severity: "warning", scope: "project", facts: [], validate() { return []; } },',
    "}));",
    "",
  ].join("\n");
}
