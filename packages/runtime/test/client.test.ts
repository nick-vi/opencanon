import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createEngine } from "@opencanon/engine";
import { createPaths } from "@opencanon/core";
import { createKnowledgeIndexManager, createProjectStore, inspectProjectRuntime, projectRuntimeStatePath, runtimeAuthHeaders, runtimeNamespaceForRegistry, startOpenCanonRuntime, stopService, stopProjectRuntime } from "@opencanon/runtime";
import { createAuthoringProject } from "./support.ts";
import { admittedJobs, assignedJobEvent, assignedProtocolEvent, emptyProtocolEventWindow, emptyPruneResult } from "./engine-binding-test-support.ts";
import {
  activityRoutesCheckSource,
  canonHistoryRouteCheckSource,
  canonRelatedChangeRouteCheckSource,
  changeEventsRouteCheckSource,
  changeTaskRoutesCheckSource,
  codeGraphRouteCheckSource,
  completeReadyHistoryCheckSource,
  doctorRouteCheckSource,
  ephemeralRuntimeClientCheckSource,
  projectContextRouteCheckSource,
  runtimeClientPipeRepairCheckSource,
  runtimeClientRepairCheckSource,
  runtimeClientStreamRepairCheckSource,
  runtimeProjectTypesCheckSource,
  runtimeSummaryRouteCheckSource,
  runtimeValidatorReloadCheckSource,
  validateTraversalCheckSource,
  validatorHelperSource,
  worktreeCoordinationStreamCheckSource,
} from "./client-test-sources.ts";

const HeavyRouteIntegrationTestTimeoutMs = 120_000;
const HeavyRouteSubprocessTimeoutMs = 90_000;
const RuntimeWatcherPropagationTimeoutMs = 30_000;

type KnowledgeStatusForTest = {
  status?: string;
  embeddingStats?: {
    filesChanged?: number;
    vectorsWritten?: number;
    chunksChanged?: number;
    chunksRemoved?: number;
  };
};

async function waitForKnowledgeStatus(
  serverUrl: string,
  headers: Record<string, string>,
  predicate: (index: KnowledgeStatusForTest | undefined) => boolean,
): Promise<KnowledgeStatusForTest> {
  const deadline = Date.now() + RuntimeWatcherPropagationTimeoutMs;
  let last: KnowledgeStatusForTest | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(serverUrl + "/api/context/status", { headers });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text) as { data?: { data?: { index?: KnowledgeStatusForTest } } };
    last = body.data?.data?.index;
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Project Knowledge watcher refresh. Last status: ${JSON.stringify(last)}`);
}

function runtimeTestVector(seed: number): number[] {
  return Array.from({ length: 896 }, (_item, index) => (index === 0 ? seed : 0));
}

test("runtime client does not expose an env-driven in-process transport path", () => {
  const source = readFileSync(path.join(process.cwd(), "packages/cli/src/runtime-client.ts"), "utf8");

  assert.doesNotMatch(source, /OPENCANON_RUNTIME_TRANSPORT/);
  assert.doesNotMatch(source, /NODE_ENV/);
  assert.doesNotMatch(source, /VITEST/);
  assert.doesNotMatch(source, /transport:\s*"in-process"/);
});

test("H2: POST /api/validate with an escaping file path is rejected with 400 (no read outside rootDir)", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-validate-traversal-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
  writeFileSync(
    path.join(rootDir, "conventions/index.ts"),
    [
      "import { defineConvention } from \"@opencanon/core\";",
      "",
      "export default defineConvention({",
      "  id: \"noop-rule\",",
      "  title: \"Noop rule\",",
      "  topics: [\"test\"],",
      "  rule: \"Noop rule.\",",
      "  applies: { kind: \"files\", globs: [\"src/**/*.ts\"] },",
      "  render: { kind: \"none\" },",
      "  runtime: {",
      "    kind: \"validator\",",
      "    severity: \"warning\",",
      "    scope: \"project\",",
      "    facts: [],",
      "    validate() { return []; },",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", validateTraversalCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GET /api/doctor returns the project doctor report for authorized API clients", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-doctor-route-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "node_modules"), { recursive: true });
  symlinkSync(path.join(process.cwd(), "node_modules/typescript"), path.join(rootDir, "node_modules/typescript"), "dir");
  writeFileSync(path.join(rootDir, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", doctorRouteCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GET /api/project/summary returns a lightweight project projection", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-summary-route-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runtimeSummaryRouteCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Code graph routes expose runtime-owned symbol and edge search", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-code-graph-routes-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "src/company.ts"),
    [
      "export function loadCompany() {",
      "  return normalizeCompany('Acme');",
      "}",
      "",
      "export function normalizeCompany(name: string) {",
      "  return name.toLowerCase();",
      "}",
      "",
    ].join("\n"),
  );

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", codeGraphRouteCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Project Knowledge routes expose search, ask, chunks, coverage, and backlinks", { timeout: HeavyRouteIntegrationTestTimeoutMs }, () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-context-routes-"));
  createAuthoringProject(rootDir);
  writeFileSync(
    path.join(rootDir, "opencanon.config.json"),
    JSON.stringify(
      {
        conventionsPath: "conventions/index.ts",
        fixturesDir: "fixtures",
        fileDiscovery: "filesystem",
        projectFilePatterns: ["src/**/*.ts", "opencanon/areas/**/*.ts"],
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
  mkdirSync(path.join(rootDir, "opencanon/areas"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export function loadCompanyInvoice() {\n  return 'invoice search term';\n}\n");
  writeFileSync(
    path.join(rootDir, "opencanon/areas/index.ts"),
    [
      "import { defineArea } from \"@opencanon/core\";",
      "",
      "export default defineArea({",
      "  id: \"billing-context\",",
      "  title: \"Billing Context\",",
      "  summary: \"Billing source is indexed for Project Knowledge.\",",
      "  owns: [{ kind: \"file\", path: \"src/company.ts\" }],",
      "  render: { kind: \"none\" },",
      "});",
      "",
    ].join("\n"),
  );

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", projectContextRouteCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: HeavyRouteSubprocessTimeoutMs,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Project Knowledge worker failure leaves the serving runtime healthy", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-knowledge-worker-failure-"));
  createAuthoringProject(rootDir);
  const server = await startOpenCanonRuntime({
    cwd: rootDir,
    port: 0,
    async runKnowledgeIndexOperation() {
      throw new Error("isolated index failure");
    },
  });
  try {
    const headers = runtimeAuthHeaders(server.authToken);
    const indexResponse = await fetch(server.url + "/api/index", { method: "POST", headers });
    const indexText = await indexResponse.text();
    assert.equal(indexResponse.status, 500, indexText);
    assert.match(indexText, /isolated index failure/u);

    const healthResponse = await fetch(server.url + "/api/health", { headers });
    const healthText = await healthResponse.text();
    assert.equal(healthResponse.status, 200, healthText);
    const health = JSON.parse(healthText) as { data?: { data?: { jobs?: Array<{ status?: string; message?: string }> } } };
    assert(health.data?.data?.jobs?.some((job) => job.status === "failed" && job.message === "isolated index failure"));

    const statusResponse = await fetch(server.url + "/api/context/status", { headers });
    assert.equal(statusResponse.status, 200, await statusResponse.text());
  } finally {
    await server.stop();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Project Knowledge watcher refreshes an existing index after file changes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-knowledge-watch-"));
  const registryPath = path.join(rootDir, ".opencanon/test-service-registry.json");
  const previousRegistryPath = process.env.OPENCANON_SERVICE_REGISTRY_PATH;
  try {
    process.env.OPENCANON_SERVICE_REGISTRY_PATH = registryPath;
    createAuthoringProject(rootDir);
    mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    writeFileSync(path.join(rootDir, "docs/guide.md"), "# Guide\n\nInitial billing knowledge.\n");
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify(
        {
          conventionsPath: "conventions/index.ts",
          fixturesDir: "fixtures",
          fileDiscovery: "filesystem",
          projectFilePatterns: ["docs/**/*.md"],
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

    let semanticIndex: unknown = null;
    const scanStatePath = path.join(rootDir, ".opencanon/state/test/state.sqlite");
    let semanticChunks: Array<{ metadata: Record<string, unknown>; text: string; vector?: number[] }> = [];
    let watcherCallback: ((error: unknown, batchJson?: string) => void) | undefined;
    const previousHashes = new Map<string, string>();
    const embedCalls: Array<{ task?: string; texts: string[] }> = [];
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
            statePath: path.join(rootDir, ".opencanon/state/test/state.sqlite"),
            schemaVersion: 6,
            migrationsApplied: [1],
            refresh: { status: "live", mode: "watch", bufferedEvents: 0 },
          }),
        scanAndDiffJson: (requestJson: string) => {
          const request = JSON.parse(requestJson) as { files?: Array<string | { path: string }> };
          const paths = (request.files ?? []).map((file) => typeof file === "string" ? file : file.path).sort();
          const files = paths.map((filePath) => {
            const content = readFileSync(path.join(rootDir, filePath), "utf8");
            return {
              path: filePath,
              contentHash: createHash("sha256").update(content).digest("hex"),
              size: Buffer.byteLength(content),
              stale: false,
            };
          });
          const current = new Map(files.map((file) => [file.path, file.contentHash]));
          const changedFiles = files.filter((file) => previousHashes.get(file.path) !== file.contentHash).map((file) => file.path);
          const unchangedFiles = files.filter((file) => previousHashes.get(file.path) === file.contentHash).map((file) => file.path);
          const deletedFiles = [...previousHashes.keys()].filter((filePath) => !current.has(filePath));
          previousHashes.clear();
          for (const file of files) previousHashes.set(file.path, file.contentHash);
          return JSON.stringify({
            statePath: path.join(rootDir, ".opencanon/state/test/state.sqlite"),
            schemaVersion: 6,
            inventoryHash: createHash("sha256").update(JSON.stringify(files.map((file) => [file.path, file.contentHash]))).digest("hex"),
            files,
            changedFiles,
            unchangedFiles,
            deletedFiles,
            staleFiles: 0,
          });
        },
        extractFactsJson: () => JSON.stringify({ files: [], diagnostics: [] }),
        buildRepoGraphJson: () => JSON.stringify({ graph: { rootDir, graphHash: "graph", files: ["docs/guide.md"], packages: [], importEdges: [] } }),
        indexCodeGraphJson: () => JSON.stringify({ generation: "test", indexed: [], deleted: [], diagnostics: [], parserVersion: "oxc-test", extractorVersion: "graph-test" }),
        activateCodeGraphJson: () => undefined,
        searchSymbolsJson: () => JSON.stringify({ symbols: [] }),
        searchReferencesJson: () => JSON.stringify({ references: [] }),
        searchGraphEdgesJson: () => JSON.stringify({ edges: [] }),
        writeProductModelProjectionJson: () => undefined,
        readProductModelProjectionJson: () => JSON.stringify({ projection: null }),
        writeSemanticIndexJson: (requestJson: string) => {
          const request = JSON.parse(requestJson) as { index: unknown; chunks: Array<{ metadata: Record<string, unknown>; text: string; vector: number[] }> };
          semanticIndex = request.index;
          semanticChunks = request.chunks;
        },
        writeSemanticIndexDeltaJson: (requestJson: string) => {
          const request = JSON.parse(requestJson) as {
            index: unknown;
            chunks?: Array<{ metadata: Record<string, unknown>; text: string; vector: number[] }>;
            removedPaths?: string[];
          };
          const removed = new Set(request.removedPaths ?? []);
          semanticIndex = request.index;
          semanticChunks = [
            ...semanticChunks.filter((chunk) => !removed.has(String(chunk.metadata.path))),
            ...(request.chunks ?? []),
          ];
        },
        readSemanticIndexStatusJson: () => JSON.stringify({ index: semanticIndex }),
        listSemanticChunksJson: () => JSON.stringify({ index: semanticIndex, chunks: semanticChunks.map((chunk) => chunk.metadata) }),
        searchSemanticIndexJson: () => JSON.stringify({ index: semanticIndex, results: semanticChunks.map((chunk) => ({ chunk: chunk.metadata, score: 1 })) }),
        embedSemanticTextsJson: (requestJson: string) => {
          const request = JSON.parse(requestJson) as { task?: string; texts: string[]; modelId: string };
          embedCalls.push({ task: request.task, texts: request.texts });
          return JSON.stringify({ modelId: request.modelId, dimensions: 896, vectors: request.texts.map((_text, index) => runtimeTestVector(index + 1)) });
        },
        generateTextJson: (requestJson: string) => {
          const request = JSON.parse(requestJson) as { modelId: string };
          return JSON.stringify({ modelId: request.modelId, text: "" });
        },
        startWatcherJson: (_requestJson: string, callback: (error: unknown, batchJson?: string) => void) => {
          watcherCallback = callback;
          return JSON.stringify({ running: true, debounceMs: 250, bufferCapacity: 128 });
        },
        drainWatcherEventsJson: () => JSON.stringify([]),
        stopWatcher: () => undefined,
        writeEventJson: () => undefined,
        listEventsJson: () => JSON.stringify([]),
        appendProtocolEventJson: (requestJson: string) => assignedProtocolEvent(requestJson),
        listProtocolEventsJson: () => emptyProtocolEventWindow(),
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

    const server = await startOpenCanonRuntime({
      cwd: rootDir,
      port: 0,
      runtime: { nodeVersion: process.versions.node, engine },
      async runKnowledgeIndexOperation(input) {
        const workerStore = createProjectStore({ rootDir, paths: createPaths(rootDir), engine, statePath: scanStatePath });
        try {
          const result = await createKnowledgeIndexManager({ rootDir, store: workerStore }).index({ force: input.force, changedPaths: input.changedPaths, onProgress: input.onProgress });
          return { index: result.index, files: result.scan.files.map((file) => file.path) };
        } finally {
          workerStore.close();
        }
      },
    });
    try {
      const headers = runtimeAuthHeaders(server.authToken);
      const initial = await fetch(server.url + "/api/index", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({}),
      });
      const initialText = await initial.text();
      assert.equal(initial.status, 200, initialText);
      const initialEmbedCount = embedCalls.filter((call) => call.task === "document").length;
      assert(initialEmbedCount >= 1);

      writeFileSync(path.join(rootDir, "docs/guide.md"), "# Guide\n\nUpdated billing knowledge with supplier review.\n");
      assert(watcherCallback, "runtime watcher callback was not registered");
      watcherCallback(null, JSON.stringify({ rootDir, paths: ["docs/guide.md"], stale: false, timestamp: new Date().toISOString() }));

      const refreshed = await waitForKnowledgeStatus(server.url, headers, (index) =>
        index?.status === "ready" &&
        index.embeddingStats?.filesChanged === 1 &&
        index.embeddingStats?.vectorsWritten === 1 &&
        embedCalls.filter((call) => call.task === "document").length > initialEmbedCount
      );
      assert.equal(refreshed.embeddingStats?.chunksChanged, 1);
      assert.equal(refreshed.embeddingStats?.chunksRemoved, 1);
    } finally {
      await server.stop();
    }
  } finally {
    if (previousRegistryPath === undefined) delete process.env.OPENCANON_SERVICE_REGISTRY_PATH;
    else process.env.OPENCANON_SERVICE_REGISTRY_PATH = previousRegistryPath;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("change event routes persist events and update the readonly board", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-change-events-route-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "opencanon/changes"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
  writeFileSync(
    path.join(rootDir, "opencanon/changes/index.ts"),
    [
      "import { defineChange } from \"@opencanon/core\";",
      "",
      "export default [",
      "  defineChange({",
      "    id: \"route-change\",",
      "    title: \"Route Change\",",
      "    kind: \"feature\",",
      "    intent: { problem: \"No route\", outcome: \"Route changes\" },",
      "    scope: [{ kind: \"file\", path: \"src/company.ts\" }],",
      "    checks: [{ id: \"project-doctor\", kind: \"doctor\" }],",
      "    render: { kind: \"none\" },",
      "  }),",
      "];",
      "",
    ].join("\n"),
  );

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", changeEventsRouteCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("change task graph routes expose ready work and persist task lifecycle state", { timeout: HeavyRouteIntegrationTestTimeoutMs }, () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-change-task-routes-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "opencanon/changes"), { recursive: true });
  mkdirSync(path.join(rootDir, "docs/opencanon"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
  writeFileSync(
    path.join(rootDir, "docs/opencanon/impact-surfaces.json"),
    JSON.stringify(
      [
        {
          id: "company-workflow",
          title: "Company Workflow",
          applies: ["src/company.ts"],
          proposed: true,
        },
      ],
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(rootDir, "opencanon/changes/index.ts"),
    [
      "import { defineChange } from \"@opencanon/core\";",
      "",
      "export default defineChange({",
      "  id: \"task-change\",",
      "  title: \"Task Change\",",
      "  kind: \"feature\",",
      "  intent: { problem: \"No task graph\", outcome: \"Task graph runs\" },",
      "  checks: [{ id: \"smoke\", kind: \"command\", command: " + JSON.stringify(`${process.execPath} -e "process.exit(0)"`) + " }],",
      "  tasks: [",
      "    { id: \"model\", title: \"Model task\", files: [\"src/company.ts\"], surfaces: [\"company-workflow\"], checks: [\"smoke\"] },",
      "    { id: \"cli\", title: \"CLI task\", files: [\"src/company.ts\"], checks: [\"smoke\"], dependsOn: [\"model\"] },",
      "  ],",
      "  render: { kind: \"none\" },",
      "});",
      "",
    ].join("\n"),
  );

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", changeTaskRoutesCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: HeavyRouteSubprocessTimeoutMs,
    });
    const failureOutput = result.error
      ? `${result.error.message}\n${result.stderr || result.stdout}`
      : result.stderr || result.stdout;
    assert.equal(result.status, 0, failureOutput);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("ready work keeps closed Changes closed beyond the recent Activity window", { timeout: HeavyRouteIntegrationTestTimeoutMs }, () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-complete-ready-history-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "opencanon/changes"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
  writeFileSync(
    path.join(rootDir, "opencanon/changes/index.ts"),
    [
      "import { defineChange } from \"@opencanon/core\";",
      "",
      "export default [",
      "  defineChange({",
      "    id: \"closed-change\",",
      "    title: \"Closed Change\",",
      "    kind: \"fix\",",
      "    intent: { problem: \"Ready work can drift\", outcome: \"Closed work stays closed\" },",
      "    tasks: [{ id: \"finish\", title: \"Finish work\", files: [\"src/company.ts\"] }],",
      "    render: { kind: \"none\" },",
      "  }),",
      "  defineChange({",
      "    id: \"unrelated-change\",",
      "    title: \"Unrelated Change\",",
      "    kind: \"feature\",",
      "    intent: { problem: \"Other activity exists\", outcome: \"Other activity remains bounded\" },",
      "    render: { kind: \"none\" },",
      "  }),",
      "];",
      "",
    ].join("\n"),
  );

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", completeReadyHistoryCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: HeavyRouteSubprocessTimeoutMs,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime stream refreshes when external worktree coordination changes", { timeout: 30000 }, () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-worktree-stream-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "opencanon/changes"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
  writeFileSync(
    path.join(rootDir, "opencanon/changes/index.ts"),
    [
      "import { defineChange } from \"@opencanon/core\";",
      "",
      "export default defineChange({",
      "  id: \"stream-change\",",
      "  title: \"Stream Change\",",
      "  kind: \"feature\",",
      "  intent: { problem: \"No live work status\", outcome: \"Active work is visible\" },",
      "  tasks: [{ id: \"model\", title: \"Model task\", files: [\"src/company.ts\"] }],",
      "  render: { kind: \"none\" },",
      "});",
      "",
    ].join("\n"),
  );

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", worktreeCoordinationStreamCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime observability and context packet routes expose bounded project activity", { timeout: 60000 }, () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-activity-routes-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "opencanon/areas"), { recursive: true });
  mkdirSync(path.join(rootDir, "opencanon/specs"), { recursive: true });
  mkdirSync(path.join(rootDir, "opencanon/changes"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const activityValue = '<activity & change>';\n");
  writeFileSync(
    path.join(rootDir, "opencanon/areas/index.ts"),
    [
      "import { defineArea } from \"@opencanon/core\";",
      "",
      "export default defineArea({",
      "  id: \"activity-area\",",
      "  title: \"Activity Area\",",
      "  summary: \"Activity is visible from the app.\",",
      "  owns: [{ kind: \"file\", path: \"src/company.ts\" }],",
      "  checks: [{ id: \"project-doctor\", kind: \"doctor\" }],",
      "  render: { kind: \"none\" },",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(rootDir, "opencanon/specs/index.ts"),
    [
      "import { defineSpec } from \"@opencanon/core\";",
      "",
      "export default defineSpec({",
      "  id: \"activity-spec\",",
      "  title: \"Activity Spec\",",
      "  summary: \"Activity reflects project state.\",",
      "  scope: [{ kind: \"file\", path: \"src/company.ts\" }],",
      "  checks: [{ id: \"project-doctor\", kind: \"doctor\" }],",
      "  render: { kind: \"none\" },",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(rootDir, "opencanon/changes/index.ts"),
    [
      "import { defineChange } from \"@opencanon/core\";",
      "",
      "export default defineChange({",
      "  id: \"activity-change\",",
      "  title: \"Activity Change\",",
      "  kind: \"feature\",",
      "  intent: { problem: \"No activity\", outcome: \"Activity is visible\" },",
      "  updates: { areas: [\"activity-area\"], specs: [\"activity-spec\"] },",
      "  scope: [{ kind: \"file\", path: \"src/company.ts\" }],",
      "  checks: [{ id: \"project-doctor\", kind: \"doctor\" }],",
      "  render: { kind: \"none\" },",
      "});",
      "",
    ].join("\n"),
  );

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", activityRoutesCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("canon history route resolves conventions, areas, and changes", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-canon-history-route-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "opencanon/areas"), { recursive: true });
  mkdirSync(path.join(rootDir, "opencanon/changes"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
  writeFileSync(
    path.join(rootDir, "conventions/index.ts"),
    [
      "import { defineConvention } from \"@opencanon/core\";",
      "",
      "export default defineConvention({",
      "  id: \"route-rule\",",
      "  title: \"Route Rule\",",
      "  topics: [\"test\"],",
      "  rule: \"Route rule.\",",
      "  applies: { kind: \"files\", globs: [\"src/**/*.ts\"] },",
      "  render: { kind: \"generated\", docs: \"docs/route-rule.md\", style: \"reference\" },",
      "  runtime: { kind: \"none\" },",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(rootDir, "docs/canon.md"), "# Canon\n\n## Route Rule\n\nRoute rule.\n");
  writeFileSync(
    path.join(rootDir, "opencanon/areas/index.ts"),
    [
      "import { defineArea } from \"@opencanon/core\";",
      "",
      "export default defineArea({",
      "  id: \"route-area\",",
      "  title: \"Route Area\",",
      "  summary: \"Route area is tracked.\",",
      "  render: { kind: \"generated\", docs: \"docs/route-area.md\", style: \"reference\" },",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(rootDir, "opencanon/changes/index.ts"),
    [
      "import { defineChange } from \"@opencanon/core\";",
      "",
      "export default defineChange({",
      "  id: \"route-change\",",
      "  title: \"Route Change\",",
      "  kind: \"feature\",",
      "  intent: { problem: \"No route\", outcome: \"Route changes\" },",
      "  render: { kind: \"generated\", docs: \"docs/route-change.md\", style: \"reference\" },",
      "});",
      "",
    ].join("\n"),
  );

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", canonHistoryRouteCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("canon related route includes areas and changes for matched files", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-related-change-route-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "opencanon/areas"), { recursive: true });
  mkdirSync(path.join(rootDir, "opencanon/changes"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
  writeFileSync(
    path.join(rootDir, "opencanon/areas/index.ts"),
    [
      "import { defineArea } from \"@opencanon/core\";",
      "",
      "export default defineArea({",
      "  id: \"company-area\",",
      "  title: \"Company Area\",",
      "  summary: \"Company behavior is tracked.\",",
      "  owns: [{ kind: \"file\", path: \"src/company.ts\" }],",
      "  render: { kind: \"none\" },",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(rootDir, "opencanon/changes/index.ts"),
    [
      "import { defineChange } from \"@opencanon/core\";",
      "",
      "export default defineChange({",
      "  id: \"company-change\",",
      "  title: \"Company Change\",",
      "  kind: \"feature\",",
      "  intent: { problem: \"No context\", outcome: \"Context includes change\" },",
      "  updates: { areas: [\"company-area\"] },",
      "  scope: [{ kind: \"file\", path: \"src/company.ts\" }],",
      "  render: { kind: \"none\" },",
      "});",
      "",
    ].join("\n"),
  );

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", canonRelatedChangeRouteCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime client lazily starts a supervised project runtime when none is running", { timeout: 60000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-ephemeral-client-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  createAuthoringProject(rootDir);
  writeFileSync(
    path.join(rootDir, "conventions/index.ts"),
    [
      "import { defineConvention } from \"@opencanon/core\";",
      "",
      "export default defineConvention({",
      "  id: \"test-rule\",",
      "  title: \"Test rule\",",
      "  topics: [\"test\"],",
      "  rule: \"Test files use the test rule.\",",
      "  applies: { kind: \"files\", globs: [\"src/**/*.ts\"] },",
      "  render: { kind: \"generated\", docs: \"docs/test-rule.md\", style: \"reference\" },",
      "  runtime: {",
      "    kind: \"validator\",",
      "    severity: \"warning\",",
      "    scope: \"project\",",
      "    facts: [],",
      "    validate() {",
      "      return [];",
      "    },",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(rootDir, "docs/canon.md"),
    ["# Canon", "", "## Test", "", "Test files use the test rule.", ""].join("\n"),
  );
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");

  try {
    assert.equal(await inspectProjectRuntime(rootDir), undefined);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", ephemeralRuntimeClientCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "development",
        OPENCANON_SERVICE_REGISTRY_PATH: registryPath,
        VITEST: "false",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const output = JSON.parse(result.stdout.trim()) as {
      summaryRootDir: string;
      relatedConventionIds: string[];
      relatedValidatorIds: string[];
      lifecycleBeforeRelated: { revision: { observed: number; accepted: number; published: number }; settled: boolean };
      lifecycleAfterRelated: { revision: { observed: number; accepted: number; published: number } };
      registered: boolean;
      projectState: boolean;
      projectRuntimeFile: boolean;
      registryRoots: string[];
      service: boolean;
    };
    assert.equal(output.summaryRootDir, realpathSync(rootDir));
    assert.deepEqual(output.relatedConventionIds, ["test-rule"]);
    assert.deepEqual(output.relatedValidatorIds, ["test-rule"]);
    assert.equal(output.lifecycleBeforeRelated.settled, true);
    assert(output.lifecycleBeforeRelated.revision.published >= 2);
    assert.deepEqual(output.lifecycleAfterRelated.revision, output.lifecycleBeforeRelated.revision);
    assert.equal(output.registered, true);
    assert.equal(output.projectRuntimeFile, true);
    assert.equal(output.projectState, true);
    assert.deepEqual(output.registryRoots, [rootDir]);
    assert.equal(output.service, true);
    assert.equal(existsSync(projectRuntimeStatePath(rootDir, runtimeNamespaceForRegistry(registryPath))), true);
  } finally {
    await stopService(registryPath);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime client repairs a supervised runtime when the registered endpoint dies", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-client-repair-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runtimeClientRepairCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCANON_SERVICE_REGISTRY_PATH: registryPath,
      },
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim()) as { firstRootDir: string; secondRootDir: string; beforePid: number; afterPid: number };
    assert.equal(output.firstRootDir, realpathSync(rootDir));
    assert.equal(output.secondRootDir, realpathSync(rootDir));
    assert.notEqual(output.afterPid, output.beforePid);
  } finally {
    await stopService(registryPath);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime client repairs a supervised runtime before resuming a stream", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-client-stream-repair-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runtimeClientStreamRepairCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCANON_SERVICE_REGISTRY_PATH: registryPath,
      },
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim()) as { beforePid: number; afterPid: number; connected: boolean };
    assert.notEqual(output.afterPid, output.beforePid);
    assert.equal(output.connected, true);
  } finally {
    await stopService(registryPath);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime client repairs a supervised runtime when the pipe endpoint disappears", async () => {
  if (process.platform === "win32") return;
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-client-pipe-repair-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runtimeClientPipeRepairCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCANON_SERVICE_REGISTRY_PATH: registryPath,
      },
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim()) as { firstRootDir: string; secondRootDir: string; beforePid: number; afterPid: number };
    assert.equal(output.firstRootDir, realpathSync(rootDir));
    assert.equal(output.secondRootDir, realpathSync(rootDir));
    assert.notEqual(output.afterPid, output.beforePid);
  } finally {
    await stopService(registryPath);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("running runtime reloads validator graph when imported validator modules change", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-validator-reload-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "validator-helpers"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
  writeFileSync(
    path.join(rootDir, "conventions/index.ts"),
    ["import validator from \"./rules.ts\";", "", "export default validator;", ""].join("\n"),
  );
  writeFileSync(
    path.join(rootDir, "conventions/rules.ts"),
    [
      "import { defineConvention } from \"@opencanon/core\";",
      "import { validatorIds } from \"../validator-helpers/rules.ts\";",
      "",
      "export default validatorIds.map((id) => defineConvention({",
      "  id,",
      "  title: id,",
      "  topics: [\"test\"],",
      "  rule: id,",
      "  applies: { kind: \"files\", globs: [\"src/**/*.ts\"] },",
      "  render: { kind: \"none\" },",
      "  runtime: { kind: \"validator\", severity: \"warning\", scope: \"project\", facts: [], validate() { return []; } },",
      "}));",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(rootDir, "validator-helpers/rules.ts"), validatorHelperSource(["first-rule"]));

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runtimeValidatorReloadCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("running runtime generates project authoring types on startup and relevant changes", { timeout: HeavyRouteIntegrationTestTimeoutMs }, () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-project-types-"));
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
      },
      null,
      2,
    ),
  );
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "fixtures/demo"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module", name: "demo-app", dependencies: { zod: "^4.0.0" } }, null, 2));
  writeFileSync(
    path.join(rootDir, "fixtures/demo/valid.ts"),
    [
      'import { defineFixture } from "@opencanon/core/testing";',
      'import leftPad from "left-pad";',
      "",
      "void leftPad;",
      "export default defineFixture({});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(rootDir, "conventions/index.ts"),
    [
      "import { defineConvention } from \"@opencanon/core\";",
      "",
      "export default defineConvention({",
      "  id: \"conventions\",",
      "  title: \"Conventions\",",
      "  topics: [\"test\"],",
      "  rule: \"Conventions.\",",
      "  applies: { kind: \"files\", globs: [\"src/**/*.ts\"] },",
      "  render: { kind: \"none\" },",
      "  runtime: { kind: \"validator\", severity: \"warning\", scope: \"project\", facts: [], validate() { return []; } },",
      "});",
      "",
    ].join("\n"),
  );

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runtimeProjectTypesCheckSource(), rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: HeavyRouteSubprocessTimeoutMs,
    });
    const failureOutput = result.error
      ? `${result.error.message}\n${result.stderr || result.stdout}`
      : result.stderr || result.stdout;
    assert.equal(result.status, 0, failureOutput);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
