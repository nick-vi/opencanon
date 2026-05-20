import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  applyRefactorPlan,
  getGitFileDiff,
  getGitFileHistory,
  lazy,
  moveFile,
  normalizeMarkdownHeading,
  parseMarkdownDoc,
  renamePackage,
  renameSymbol,
  resolveDocsReferences,
  resolveInsideRoot,
  resource,
  safeRelativePath,
  updateImports,
} from "@opencanon/core";

test("lazy caches sync values and can reset", () => {
  let calls = 0;
  const getValue = lazy(() => {
    calls += 1;
    return { calls };
  });

  const first = getValue();
  const second = getValue();

  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(getValue.isReady(), true);

  getValue.reset();

  assert.equal(getValue.isReady(), false);
  assert.equal(getValue().calls, 2);
});

test("safe path utilities reject traversal outside the root", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-safe-path-"));
  const outsideDir = mkdtempSync(path.join(tmpdir(), "opencanon-safe-path-outside-"));

  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    symlinkSync(outsideDir, path.join(rootDir, "linked"));

    assert.deepEqual(safeRelativePath("./src/index.ts"), { ok: true, path: "src/index.ts" });
    assert.equal(safeRelativePath("../secret.txt").ok, false);
    assert.equal(safeRelativePath("/tmp/secret.txt").ok, false);
    assert.equal(safeRelativePath("C:/secret.txt").ok, false);

    const resolved = resolveInsideRoot(rootDir, "src/index.ts");
    assert.equal(resolved.ok, true);
    if (resolved.ok) assert.equal(resolved.absolutePath, path.join(rootDir, "src/index.ts"));
    assert.equal(resolveInsideRoot(rootDir, "../secret.txt").ok, false);
    assert.equal(resolveInsideRoot(rootDir, "linked/secret.txt").ok, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("refactor plans rename symbols and apply text edits", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-refactor-rename-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/company.ts"), "export function loadCompany() {\n  return loadCompany.name;\n}\n");

    const plan = renameSymbol({ rootDir, from: "loadCompany", to: "getCompany", files: ["src/company.ts"] });
    assert.equal(plan.diagnostics.length, 0);
    assert.equal(plan.edits.length, 2);

    const result = applyRefactorPlan({ rootDir, plan });
    assert.equal(result.appliedEdits, 2);
    assert.equal(readFileSync(path.join(rootDir, "src/company.ts"), "utf8"), "export function getCompany() {\n  return getCompany.name;\n}\n");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("refactor plans can use graph ranges for symbol rename", () => {
  const plan = renameSymbol({
    rootDir: "/repo",
    from: "loadCompany",
    to: "getCompany",
    graphOnly: true,
    symbols: [
      {
        id: "symbol",
        path: "src/company.ts",
        language: "typescript",
        kind: "function",
        name: "loadCompany",
        qualifiedName: "src/company.ts::loadCompany",
        exported: true,
        range: {
          start: { line: 1, column: 17, byte: 16 },
          end: { line: 1, column: 28, byte: 27 },
        },
      },
    ],
    references: [
      {
        id: "reference",
        path: "src/route.ts",
        language: "typescript",
        name: "loadCompany",
        kind: "import-named",
        source: "../company",
        range: {
          start: { line: 1, column: 10, byte: 9 },
          end: { line: 1, column: 21, byte: 20 },
        },
        provenance: "oxc",
        confidence: "syntactic",
      },
    ],
  });

  assert.equal(plan.diagnostics.length, 0);
  assert.deepEqual(
    plan.edits.map((edit) => `${edit.file}:${edit.range.startLine}:${edit.range.startColumn}`),
    ["src/company.ts:1:17", "src/route.ts:1:10"],
  );

  const scoped = renameSymbol({
    rootDir: "/repo",
    from: "loadCompany",
    to: "getCompany",
    graphOnly: true,
    files: ["src/company.ts"],
    symbols: plan.edits.map((edit, index) => ({
      id: `symbol-${index}`,
      path: edit.file,
      language: "typescript",
      kind: "function",
      name: "loadCompany",
      qualifiedName: `${edit.file}::loadCompany`,
      exported: true,
      range: {
        start: { line: edit.range.startLine, column: edit.range.startColumn, byte: 0 },
        end: { line: edit.range.endLine, column: edit.range.endColumn, byte: 0 },
      },
    })),
  });
  assert.deepEqual(scoped.edits.map((edit) => edit.file), ["src/company.ts"]);
});

test("refactor graph-only rename reports missing graph references", () => {
  const plan = renameSymbol({ rootDir: "/repo", from: "loadCompany", to: "getCompany", graphOnly: true });
  assert(plan.diagnostics.includes("No graph references found for symbol: loadCompany"));
});

test("refactor graph-only rename blocks ambiguous declarations", () => {
  const symbol = {
    path: "src/company.ts",
    language: "typescript",
    kind: "function" as const,
    name: "loadCompany",
    exported: true,
    range: {
      start: { line: 1, column: 17, byte: 16 },
      end: { line: 1, column: 28, byte: 27 },
    },
  };
  const plan = renameSymbol({
    rootDir: "/repo",
    from: "loadCompany",
    to: "getCompany",
    graphOnly: true,
    symbols: [
      { ...symbol, id: "one", qualifiedName: "src/company.ts::loadCompany" },
      { ...symbol, id: "two", path: "src/other.ts", qualifiedName: "src/other.ts::loadCompany" },
    ],
  });

  assert(plan.diagnostics.includes("Ambiguous graph rename for symbol loadCompany: 2 declarations match."));
  assert.equal(plan.edits.length, 0);
});

test("refactor package rename includes package manifests", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-refactor-package-"));
  try {
    mkdirSync(path.join(rootDir, "packages/core"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ dependencies: { "@old/core": "workspace:*" } }, null, 2));
    writeFileSync(path.join(rootDir, "packages/core/package.json"), JSON.stringify({ name: "@old/core" }, null, 2));

    const plan = renamePackage({ rootDir, from: "@old/core", to: "@new/core" });
    assert.deepEqual(
      plan.edits.map((edit) => edit.file).sort(),
      ["package.json", "packages/core/package.json"],
    );

    const result = applyRefactorPlan({ rootDir, plan });
    assert.equal(result.appliedEdits, 2);
    assert(readFileSync(path.join(rootDir, "package.json"), "utf8").includes("@new/core"));
    assert(readFileSync(path.join(rootDir, "packages/core/package.json"), "utf8").includes("@new/core"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("refactor plans update imports for file moves", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-refactor-move-"));
  try {
    mkdirSync(path.join(rootDir, "src/services"), { recursive: true });
    mkdirSync(path.join(rootDir, "src/domain"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/domain/company.ts"), "export const company = true;\n");
    writeFileSync(path.join(rootDir, "src/services/company.ts"), "import { company } from \"../domain/company\";\nexport { company };\n");

    const importPlan = updateImports({
      rootDir,
      from: "src/domain/company.ts",
      to: "src/domain/customer.ts",
      files: ["src/services/company.ts"],
    });
    assert.equal(importPlan.edits[0]?.replacement, "../domain/customer");

    const movePlan = moveFile({
      rootDir,
      from: "src/domain/company.ts",
      to: "src/domain/customer.ts",
      files: ["src/services/company.ts"],
    });
    const result = applyRefactorPlan({ rootDir, plan: movePlan });
    assert.equal(result.appliedEdits, 1);
    assert.equal(result.movedFiles, 1);
    assert.equal(existsSync(path.join(rootDir, "src/domain/customer.ts")), true);
    assert.equal(readFileSync(path.join(rootDir, "src/services/company.ts"), "utf8"), "import { company } from \"../domain/customer\";\nexport { company };\n");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("lazy deduplicates in-flight async work and retries after failure", async () => {
  let calls = 0;
  let release: ((value: string) => void) | undefined;
  const getValue = lazy(async () => {
    calls += 1;
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  });

  const first = getValue();
  const second = getValue();
  assert.equal(first, second);
  assert.equal(getValue.isReady(), false);

  release?.("ready");
  assert.equal(await first, "ready");
  assert.equal(await second, "ready");
  assert.equal(calls, 1);
  assert.equal(getValue.isReady(), true);

  let attempts = 0;
  const getRetried = lazy(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("first failure");
    return "ok";
  });

  await assert.rejects(() => getRetried(), /first failure/);
  assert.equal(await getRetried(), "ok");
  assert.equal(attempts, 2);
});

test("lazy reset prevents stale in-flight results from becoming ready", async () => {
  let releaseFirst: ((value: string) => void) | undefined;
  let releaseSecond: ((value: string) => void) | undefined;
  let calls = 0;
  const getValue = lazy(async () => {
    calls += 1;
    return new Promise<string>((resolve) => {
      if (calls === 1) releaseFirst = resolve;
      else releaseSecond = resolve;
    });
  });

  const first = getValue();
  getValue.reset();
  const second = getValue();

  releaseFirst?.("stale");
  assert.equal(await first, "stale");
  assert.equal(getValue.isReady(), false);

  releaseSecond?.("fresh");
  assert.equal(await second, "fresh");
  assert.equal(await getValue(), "fresh");
  assert.equal(calls, 2);
});

test("resource initializes lazily, disposes, and reinitializes", async () => {
  let initCalls = 0;
  let disposeCalls = 0;
  const managed = resource({
    init() {
      initCalls += 1;
      return { id: initCalls };
    },
    dispose() {
      disposeCalls += 1;
    },
  });

  const first = await managed.get();
  const second = await managed.get();

  assert.equal(first, second);
  assert.equal(first.id, 1);
  assert.equal(managed.isReady(), true);

  await managed.dispose();

  assert.equal(disposeCalls, 1);
  assert.equal(managed.isReady(), false);
  assert.equal((await managed.get()).id, 2);
});

test("markdown doc refs resolve normalized headings without section ids", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-docrefs-"));
  try {
    mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    writeFileSync(path.join(rootDir, "docs/decisions.json"), "[]\n");
    writeFileSync(path.join(rootDir, "docs/canon.md"), ["# Canon", "", "## API Routes!", "", "Routes call services.", "", "## API Routes!", "", "Duplicate heading."].join("\n"));

    const snippets = parseMarkdownDoc("## Café Routes!\n\nBody\n\n## Café Routes!\n", "docs/canon.md");
    assert.equal(normalizeMarkdownHeading("`API` Routes!"), "api-routes");
    assert.deepEqual(
      snippets.map((snippet) => snippet.slug),
      ["cafe-routes", "cafe-routes-1"],
    );

    const resolved = resolveDocsReferences(
      { rootDir, decisionsPath: path.join(rootDir, "docs/decisions.json") },
      ["docs/canon.md#api-routes"],
      new Map([["docs/canon.md#api-routes", ["route-decision"]]]),
    );

    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].heading, "API Routes!");
    assert.equal(resolved[0].decisionIds[0], "route-decision");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resource shares in-flight init and waits before dispose", async () => {
  let release: ((value: { id: number }) => void) | undefined;
  let initCalls = 0;
  let disposeCalls = 0;
  const managed = resource({
    init() {
      initCalls += 1;
      return new Promise<{ id: number }>((resolve) => {
        release = resolve;
      });
    },
    dispose() {
      disposeCalls += 1;
    },
  });

  const first = managed.get();
  const second = managed.get();
  assert.equal(first, second);

  const disposing = managed.dispose();
  release?.({ id: 1 });

  assert.deepEqual(await first, { id: 1 });
  await disposing;

  assert.equal(initCalls, 1);
  assert.equal(disposeCalls, 1);
  assert.equal(managed.isReady(), false);
});

test("git file history includes commit metadata and file diff", () => {
  if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0) return;

  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-history-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    runGit(rootDir, ["init"]);
    runGit(rootDir, ["config", "user.name", "OpenCanon Test"]);
    runGit(rootDir, ["config", "user.email", "test@example.com"]);
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = 1;\n");
    runGit(rootDir, ["add", "src/company.ts"]);
    runGit(rootDir, ["commit", "-m", "add company"]);
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = 2;\n");
    runGit(rootDir, ["add", "src/company.ts"]);
    runGit(rootDir, ["commit", "-m", "update company"]);

    const history = getGitFileHistory(rootDir, ["src/company.ts"], 2);
    const commit = history.histories[0]?.commits[0];
    const diff = getGitFileDiff(rootDir, "src/company.ts", commit?.fullHash ?? "");

    assert.equal(history.diagnostics.length, 0);
    assert.equal(commit?.author, "OpenCanon Test");
    assert.equal(commit?.subject, "update company");
    assert.equal(commit?.fullHash.length, 40);
    assert.equal(diff.diagnostics.length, 0);
    assert.equal(diff.beforeContent, "export const company = 1;\n");
    assert.equal(diff.afterContent, "export const company = 2;\n");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function runGit(rootDir: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("resource does not register process signal handlers by default", async () => {
  const before = process.listenerCount("SIGTERM");
  const managed = resource({
    init: () => "value",
    dispose: () => undefined,
  });

  await managed.get();

  assert.equal(process.listenerCount("SIGTERM"), before);
  await managed.dispose();
});
