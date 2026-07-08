import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { inspectProjectRuntime, stopService, stopProjectRuntime } from "@opencanon/runtime";
import { createAuthoringProject } from "./support.ts";

const HeavyRouteIntegrationTestTimeoutMs = 120_000;
const HeavyRouteSubprocessTimeoutMs = 90_000;
const RuntimeWatcherPropagationTimeoutMs = 30_000;

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

test("Project Context routes expose search, ask, chunks, coverage, and backlinks", () => {
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
          showDownloadProgress: true,
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
      "  summary: \"Billing source is indexed for Project Context.\",",
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
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
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

test("change check route runs a declared check and records pass/fail events", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-change-check-route-"));
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
      "  id: \"check-change\",",
      "  title: \"Check Change\",",
      "  kind: \"feature\",",
      "  intent: { problem: \"No check\", outcome: \"Check runs\" },",
      "  checks: [{ id: \"smoke\", kind: \"command\", command: " + JSON.stringify(`${process.execPath} -e "console.log(process.env.OPENCANON_SERVICE_REGISTRY_PATH)"`) + " }],",
      "  render: { kind: \"none\" },",
      "});",
      "",
    ].join("\n"),
  );

  try {
    const callerRegistryPath = path.join(rootDir, "global", "caller-service.json");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", changeCheckRouteCheckSource(), rootDir, callerRegistryPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCANON_SERVICE_REGISTRY_PATH: callerRegistryPath,
      },
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

function doctorRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  const coreUrl = pathToFileURL(path.join(process.cwd(), "packages/core/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { createPaths } from ${JSON.stringify(coreUrl)};
    import { runtimeAuthHeaders, startOpenCanonRuntime, openProjectStore } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      const unauthorized = await fetch(server.url + "/api/doctor");
      assert.equal(unauthorized.status, 401);

      const response = await fetch(server.url + "/api/doctor", { headers: runtimeAuthHeaders(server.authToken) });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true);
      assert(["pass", "warn", "fail"].includes(body.data.status));
      assert(body.data.checks.some((check) => check.id === "config"));
      assert(body.data.checks.some((check) => check.id === "context-files"));
    } finally {
      await server.stop();
    }

    const store = openProjectStore({ rootDir, paths: createPaths(rootDir) });
    try {
      const records = store.listObservabilityRecords({ limit: 100 });
      assert(records.spans.some((span) => span.name === "runtime.request" && span.attributes.path === "/api/doctor"));
      assert(records.spans.some((span) => span.name === "doctor.report"));
    } finally {
      store.close();
    }
  `;
}

function runtimeSummaryRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      const unauthorized = await fetch(server.url + "/api/project/summary");
      assert.equal(unauthorized.status, 401);

      const response = await fetch(server.url + "/api/project/summary", { headers: runtimeAuthHeaders(server.authToken) });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true, text);
      assert.equal(body.data.rootDir, rootDir);
      assert(["indexing", "ready"].includes(body.data.health.status), body.data.health.status);
      assert.equal(typeof body.data.files, "number");
      assert.equal(typeof body.data.findings, "number");
      assert.equal(typeof body.data.staleFiles, "number");
      assert.equal(typeof body.data.graphHash, "string");
      assert.equal(typeof body.data.lastIndexedAt, "string");
      assert.equal(typeof body.data.semanticIndex.status, "string");
      assert.equal(typeof body.data.productModel.nodes, "number");
      assert.equal("files" in body.data && Array.isArray(body.data.files), false);
      assert.equal("definitionGraph" in body.data, false);

      let readySummary = body.data;
      for (let attempt = 0; attempt < 100 && readySummary.health.status !== "ready"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const readyResponse = await fetch(server.url + "/api/project/summary", { headers: runtimeAuthHeaders(server.authToken) });
        const readyText = await readyResponse.text();
        assert.equal(readyResponse.status, 200, readyText);
        readySummary = JSON.parse(readyText).data;
      }
      assert.equal(readySummary.health.status, "ready");
      assert.equal(readySummary.semanticIndex.status, "ready");
    } finally {
      await server.stop();
    }
  `;
}

function codeGraphRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    const headers = runtimeAuthHeaders(server.authToken);
    async function get(path) {
      const response = await fetch(server.url + path, { headers });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true, text);
      return body.data;
    }
    try {
      const indexResponse = await fetch(server.url + "/api/index", { method: "POST", headers });
      const indexText = await indexResponse.text();
      assert.equal(indexResponse.status, 200, indexText);

      const symbols = await get("/api/code/symbols?query=loadCompany&limit=10");
      assert.equal(typeof symbols.sourceFiles, "number");
      assert(symbols.symbols.some((symbol) => symbol.name === "loadCompany" && symbol.path === "src/company.ts"));

      const references = await get("/api/code/symbols?query=normalizeCompany&references=1&limit=10");
      assert(references.references.some((reference) => reference.name === "normalizeCompany" && reference.path === "src/company.ts"));

      const graph = await get("/api/code/graph?query=normalizeCompany&kind=call&direction=incoming&limit=10");
      assert(graph.edges.some((edge) => edge.source.name === "loadCompany" && edge.target.name === "normalizeCompany"));
    } finally {
      await server.stop();
    }
  `;
}

function projectContextRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    const headers = runtimeAuthHeaders(server.authToken);
    async function get(path) {
      const response = await fetch(server.url + path, { headers });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true, text);
      return body.data;
    }
    async function post(path) {
      const response = await fetch(server.url + path, { method: "POST", headers });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true, text);
      return body.data;
    }
    try {
      await post("/api/index");
      const compactResponse = await fetch(server.url + "/api/index", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ response: "semantic-index" }),
      });
      const compactText = await compactResponse.text();
      assert.equal(compactResponse.status, 200, compactText);
      const compactBody = JSON.parse(compactText);
      assert.equal(compactBody.ok, true, compactText);
      assert.equal(typeof compactBody.data.semanticIndex.status, "string");
      assert.equal(compactBody.data.semanticIndex.provider.kind, "local");
      assert.equal("state" in compactBody.data, false);
      assert.equal("files" in compactBody.data, false);

      const status = await get("/api/context/status");
      assert.equal(status.index.status, "ready");

      const search = await get("/api/context/search?query=invoice%20search%20term&limit=5");
      assert.equal(search.results[0].file, "src/company.ts");
      assert(search.results[0].definitions.length >= 0);
      const definitionSearch = await get("/api/context/search?query=Billing%20Context&limit=5");
      assert(definitionSearch.results.some((item) => item.file === "src/company.ts"));

      const ask = await get("/api/context/ask?query=where%20is%20invoice%20search%20term");
      assert.equal(ask.deterministic, true);
      assert(ask.evidence.some((item) => item.file === "src/company.ts"));

      const chunks = await get("/api/context/chunks?path=src/company.ts");
      assert(chunks.chunks.some((chunk) => chunk.path === "src/company.ts"));
      const definitionChunks = await get("/api/context/chunks?definition=billing-context");
      assert(definitionChunks.chunks.some((chunk) => chunk.path === "src/company.ts"));
      const missingDefinitionChunks = await get("/api/context/chunks?definition=missing-context");
      assert.equal(missingDefinitionChunks.chunks.length, 0);

      const coverage = await get("/api/context/coverage");
      assert(coverage.totals.files >= 1);
      assert(coverage.files.some((file) => file.file === "src/company.ts"));

      const backlinks = await get("/api/context/backlinks?query=src/company.ts");
      assert(backlinks.files.some((file) => file.file === "src/company.ts"));
      const definitionBacklinks = await get("/api/context/backlinks?query=billing-context");
      assert(definitionBacklinks.links.some((link) => link.kind === "area" && link.id === "billing-context"));
    } finally {
      await server.stop();
    }
  `;
}

function canonRelatedChangeRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      const response = await fetch(server.url + "/api/canon/related?file=src/company.ts", { headers: runtimeAuthHeaders(server.authToken) });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true);
      assert.deepEqual(body.data.areas.map((item) => item.id), ["company-area"]);
      assert.deepEqual(body.data.changes.map((item) => item.id), ["company-change"]);

      const postResponse = await fetch(server.url + "/api/canon/related", {
        method: "POST",
        headers: { ...runtimeAuthHeaders(server.authToken), "content-type": "application/json" },
        body: JSON.stringify({ files: ["src/company.ts"] }),
      });
      const postText = await postResponse.text();
      assert.equal(postResponse.status, 200, postText);
      const postBody = JSON.parse(postText);
      assert.equal(postBody.ok, true);
      assert.deepEqual(postBody.data.areas.map((item) => item.id), ["company-area"]);
      assert.deepEqual(postBody.data.changes.map((item) => item.id), ["company-change"]);
    } finally {
      await server.stop();
    }
  `;
}

function activityRoutesCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    const headers = { ...runtimeAuthHeaders(server.authToken), "content-type": "application/json" };
    try {
      const started = await fetch(server.url + "/api/changes/events", {
        method: "POST",
        headers,
        body: JSON.stringify({
          changeId: "activity-change",
          type: "change-started",
          summary: "Started <activity & change>.",
          actor: "test",
          files: ["src/company.ts"],
        }),
      });
      assert.equal(started.status, 200, await started.text());

      const observability = await fetch(server.url + "/api/observability?limit=100", { headers: runtimeAuthHeaders(server.authToken) });
      const observabilityText = await observability.text();
      assert.equal(observability.status, 200, observabilityText);
      const observabilityBody = JSON.parse(observabilityText);
      assert.equal(observabilityBody.ok, true);
      assert(observabilityBody.data.spans.some((span) => span.name === "runtime.request" && span.attributes.path === "/api/changes/events"));

      const traceId = observabilityBody.data.spans[0]?.traceId;
      if (traceId) {
        const filtered = await fetch(server.url + "/api/observability?traceId=" + encodeURIComponent(traceId), { headers: runtimeAuthHeaders(server.authToken) });
        const filteredBody = await filtered.json();
        assert.equal(filteredBody.ok, true);
        assert(filteredBody.data.spans.every((span) => span.traceId === traceId));
      }

      const packet = await fetch(server.url + "/api/context/packet?file=src/company.ts&changeId=activity-change&mode=review&limit=10", { headers: runtimeAuthHeaders(server.authToken) });
      const packetText = await packet.text();
      assert.equal(packet.status, 200, packetText);
      const packetBody = JSON.parse(packetText);
      assert.equal(packetBody.ok, true);
      assert.equal(packetBody.data.schema, "opencanon.context-packet.v1");
      assert.equal(packetBody.data.mode, "review");
      assert.deepEqual(packetBody.data.filters.files, ["src/company.ts"]);
      assert.deepEqual(packetBody.data.filters.changeIds, ["activity-change"]);
      assert(packetBody.data.xml.includes('<changes>'));
      assert(packetBody.data.xml.includes('activity-change'));
      assert(packetBody.data.xml.includes('Started &lt;activity &amp; change&gt;.'));
      assert(packetBody.data.xml.includes('embedded="'));
      assert(packetBody.data.xml.includes('reused="'));
      assert.equal(packetBody.data.facts.changes, 1);
      assert.equal(packetBody.data.facts.checks, 1);
      assert.equal(typeof packetBody.data.facts.semanticIndexEmbeddedChunks, "number");
      assert.equal(typeof packetBody.data.facts.semanticIndexReusedChunks, "number");

      const unsafe = await fetch(server.url + "/api/context/packet?file=../escape.ts", { headers: runtimeAuthHeaders(server.authToken) });
      assert.equal(unsafe.status, 400);

      const unknownChange = await fetch(server.url + "/api/context/packet?changeId=missing-change", { headers: runtimeAuthHeaders(server.authToken) });
      assert.equal(unknownChange.status, 404);
    } finally {
      await server.stop();
    }
  `;
}

function changeCheckRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import path from "node:path";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const callerRegistryPath = process.argv[2];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      const headers = { ...runtimeAuthHeaders(server.authToken), "content-type": "application/json" };
      const response = await fetch(server.url + "/api/changes/checks/run", {
        method: "POST",
        headers,
        body: JSON.stringify({ changeId: "check-change", checkId: "smoke", actor: "test" }),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true);
      assert.equal(body.data.result.status, "passed");
      const checkRegistryPath = body.data.result.output.trim();
      assert.notEqual(checkRegistryPath, callerRegistryPath);
      assert(checkRegistryPath.startsWith(path.join(rootDir, ".opencanon", "check-")), checkRegistryPath);
      assert.equal(body.data.event.type, "check-passed");
      assert.equal(body.data.changes.find((change) => change.id === "check-change").boardColumn, "ready");

      const eventsResponse = await fetch(server.url + "/api/changes/events?changeId=check-change", { headers: runtimeAuthHeaders(server.authToken) });
      const eventsText = await eventsResponse.text();
      assert.equal(eventsResponse.status, 200, eventsText);
      const eventsBody = JSON.parse(eventsText);
      assert.deepEqual(eventsBody.data.map((event) => event.type).sort(), ["check-passed", "check-started"]);
    } finally {
      await server.stop();
    }
  `;
}

function changeTaskRoutesCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { mkdirSync } from "node:fs";
    import path from "node:path";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    mkdirSync(path.join(rootDir, ".opencanon"), { recursive: true });
    process.env.OPENCANON_WORKTREE_DB = path.join(rootDir, ".opencanon", "worktrees-test.sqlite");
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    const headers = { ...runtimeAuthHeaders(server.authToken), "content-type": "application/json" };
    async function get(path) {
      const response = await fetch(server.url + path, { headers: runtimeAuthHeaders(server.authToken) });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true, text);
      return body.data;
    }
    async function post(path, body) {
      const response = await fetch(server.url + path, { method: "POST", headers, body: JSON.stringify(body) });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const parsed = JSON.parse(text);
      assert.equal(parsed.ok, true, text);
      return parsed.data;
    }

    try {
      const initialReady = await get("/api/changes/ready");
      assert.deepEqual(initialReady.ready.map((item) => item.taskId), ["model"]);
      assert.deepEqual(initialReady.ready[0].surfaces, ["company-workflow"]);
      assert(initialReady.ready[0].suggestedCommands.some((command) => command.includes("opencanon changes claim task-change --task model")));
      assert.deepEqual(initialReady.blocked.map((item) => item.taskId), ["cli"]);
      assert(initialReady.blocked[0].blockedReasons.some((reason) => reason.includes("waits for model")));

      const claimed = await post("/api/changes/events", {
        changeId: "task-change",
        taskId: "model",
        type: "task-claimed",
        summary: "Claimed model task.",
        actor: "test",
      });
      assert.equal(claimed.event.taskIds[0], "model");
      assert.equal(claimed.event.type, "task-claimed");

      const started = await post("/api/changes/events", {
        changeId: "task-change",
        taskId: "model",
        type: "task-started",
        summary: "Started model task from the claimed worktree.",
      });
      assert.equal(started.event.type, "task-started");
      assert.equal(started.event.actor, "test");

      const duplicateClaim = await fetch(server.url + "/api/changes/events", {
        method: "POST",
        headers,
        body: JSON.stringify({
          changeId: "task-change",
          taskId: "model",
          type: "task-claimed",
          summary: "Other agent tried to claim model task.",
          actor: "other",
        }),
      });
      const duplicateText = await duplicateClaim.text();
      assert.equal(duplicateClaim.status, 409, duplicateText);
      assert.match(duplicateText, /already claimed by test/);

      const worktrees = await get("/api/worktrees");
      assert.deepEqual(worktrees.leases.filter((lease) => lease.status === "active").map((lease) => lease.taskId), ["model"]);

      const startedSnapshot = await get("/api/snapshot");
      const startedChange = startedSnapshot.changes.find((item) => item.id === "task-change");
      assert.equal(startedChange.tasks.find((task) => task.id === "model").status, "running");
      assert.deepEqual(startedChange.tasks.find((task) => task.id === "model").surfaces, ["company-workflow"]);
      assert.equal(startedChange.readyTaskCount, 0);

      await post("/api/changes/events", {
        changeId: "task-change",
        taskId: "model",
        type: "task-closed",
        summary: "Closed model task.",
        actor: "test",
      });
      const modelClosedSnapshot = await get("/api/snapshot");
      const modelClosedChange = modelClosedSnapshot.changes.find((item) => item.id === "task-change");
      assert.equal(modelClosedChange.lastEvent.type, "task-closed");
      assert.equal(modelClosedChange.boardColumn, "ready");
      const nextReady = await get("/api/changes/ready");
      assert.deepEqual(nextReady.ready.map((item) => item.taskId), ["cli"]);
      assert.equal(nextReady.blocked.length, 0);
      const releasedWorktrees = await get("/api/worktrees");
      assert.equal(releasedWorktrees.leases.filter((lease) => lease.status === "active").length, 0);

      const check = await post("/api/changes/checks/run", {
        changeId: "task-change",
        taskId: "cli",
        all: true,
        actor: "test",
      });
      assert.equal(check.results.length, 1);
      assert.equal(check.result.taskId, "cli");
      assert.equal(check.event.type, "task-check-passed");
      assert.deepEqual(check.event.taskIds, ["cli"]);
      assert.deepEqual(check.event.checkIds, ["smoke"]);

      const cliEvents = await get("/api/changes/events?changeId=task-change&taskId=cli");
      assert(cliEvents.every((event) => event.taskIds.includes("cli")));
      assert(cliEvents.some((event) => event.type === "task-check-passed"));

      const packet = await get("/api/context/packet?changeId=task-change&limit=10");
      assert(packet.xml.includes("<ready-work>"));
      assert(packet.xml.includes("task-change"));
      assert(packet.xml.includes('surface id="company-workflow"'));
      assert.equal(typeof packet.facts.readyTasks, "number");
    } finally {
      await server.stop();
    }
  `;
}

function worktreeCoordinationStreamCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { mkdirSync, realpathSync } from "node:fs";
    import path from "node:path";
    import { claimTaskLease, runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    mkdirSync(path.join(rootDir, ".opencanon"), { recursive: true });
    process.env.OPENCANON_WORKTREE_DB = path.join(rootDir, ".opencanon", "worktrees-stream.sqlite");
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    const seenEvents = [];
    try {
      const stream = await fetch(server.url + "/api/events/stream", { headers: runtimeAuthHeaders(server.authToken) });
      assert.equal(stream.status, 200, "expected authorized runtime stream");
      assert(stream.body, "expected runtime stream body");
      const reader = stream.body.getReader();
      await waitForRuntimeEvent(reader, (event) => event.type === "snapshot" && event.summary === "Connected to runtime stream.");
      await delay(100);
      const updatePromise = waitForRuntimeEvent(reader, (event) => {
        if (event.type !== "snapshot") return false;
        const change = event.snapshot?.changes?.find((item) => item.id === "stream-change");
        const task = change?.tasks?.find((item) => item.id === "model");
        return task?.status === "claimed" && task?.lease?.agentId === "agent-a";
      });

      const claim = claimTaskLease({
        rootDir,
        changeId: "stream-change",
        taskId: "model",
        agentId: "agent-a",
        worktreePath: rootDir,
        branch: "stream-change-model",
        ttlMs: 60000,
      });
      assert.equal(claim.ok, true, JSON.stringify(claim));

      await updatePromise.catch(async (error) => {
        const snapshotResponse = await fetch(server.url + "/api/snapshot", { headers: runtimeAuthHeaders(server.authToken) });
        const snapshotBody = await snapshotResponse.json();
        const eventResponse = await fetch(server.url + "/api/events?limit=10", { headers: runtimeAuthHeaders(server.authToken) });
        const eventBody = await eventResponse.json();
        const task = snapshotBody.data?.changes?.find((item) => item.id === "stream-change")?.tasks?.find((item) => item.id === "model");
        const summaries = (eventBody.data ?? []).map((item) => item.summary).join(" | ");
        throw new Error(error.message + " Route task: " + (task?.status ?? "-") + ":" + (task?.lease?.agentId ?? "-") + ". Runtime events: " + summaries);
      });
      const worktreesResponse = await fetch(server.url + "/api/worktrees", { headers: runtimeAuthHeaders(server.authToken) });
      const worktreesBody = await worktreesResponse.json();
      const activeLease = worktreesBody.data.leases.find((lease) => lease.changeId === "stream-change" && lease.taskId === "model" && lease.status === "active");
      assert.equal(activeLease.agentId, "agent-a");
      const snapshotBody = await waitForClaimedSnapshotRoute();
      const change = snapshotBody.changes.find((item) => item.id === "stream-change");
      const task = change.tasks.find((item) => item.id === "model");
      assert.equal(change.readyTaskCount, 0);
      assert.equal(task.lease.worktreePath, realpathSync(rootDir));
      assert.equal(task.lease.status, "active");
      await reader.cancel();
    } finally {
      await server.stop();
    }

    async function waitForRuntimeEvent(reader, predicate) {
      const decoder = new TextDecoder();
      const deadline = Date.now() + 30000;
      let buffer = "";
      let pendingRead;
      while (Date.now() < deadline) {
        pendingRead ??= reader.read();
        const read = await Promise.race([pendingRead, delay(250).then(() => null)]);
        if (read === null) continue;
        pendingRead = undefined;
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        while (true) {
          const frameEnd = buffer.indexOf("\\n\\n");
          if (frameEnd < 0) break;
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          const parsed = parseSseFrame(frame);
          if (parsed) {
            const task = parsed.snapshot?.changes?.find((item) => item.id === "stream-change")?.tasks?.find((item) => item.id === "model");
            seenEvents.push(parsed.type + ":" + parsed.summary + ":" + (task?.status ?? "-") + ":" + (task?.lease?.agentId ?? "-"));
          }
          if (parsed && predicate(parsed)) return parsed;
        }
      }
      throw new Error("Timed out waiting for active-work stream update. Seen: " + seenEvents.join(" | "));
    }

    async function waitForClaimedSnapshotRoute() {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const response = await fetch(server.url + "/api/snapshot", { headers: runtimeAuthHeaders(server.authToken) });
        const body = await response.json();
        const change = body.data?.changes?.find((item) => item.id === "stream-change");
        const task = change?.tasks?.find((item) => item.id === "model");
        if (task?.status === "claimed" && task?.lease?.agentId === "agent-a") return body.data;
        await delay(250);
      }
      throw new Error("Timed out waiting for active-work snapshot route.");
    }

    function parseSseFrame(frame) {
      let eventName = "message";
      let data = "";
      for (const line of frame.split(/\\r?\\n/)) {
        if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
        if (line.startsWith("data:")) data += line.slice("data:".length).trimStart();
      }
      if (!eventName || !data) return undefined;
      return JSON.parse(data);
    }

    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
  `;
}

function canonHistoryRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      const headers = runtimeAuthHeaders(server.authToken);
      const cases = [
        { kind: "convention", id: "route-rule", file: "conventions/index.ts", doc: "docs/route-rule.md" },
        { kind: "area", id: "route-area", file: "opencanon/areas/index.ts", doc: "docs/route-area.md" },
        { kind: "change", id: "route-change", file: "opencanon/changes/index.ts", doc: "docs/route-change.md" },
      ];
      for (const item of cases) {
        const response = await fetch(server.url + "/api/canon/history?kind=" + item.kind + "&id=" + item.id, { headers });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        const body = JSON.parse(text);
        assert.equal(body.ok, true);
        assert.equal(body.data.target.kind, item.kind);
        assert.equal(body.data.target.id, item.id);
        assert(body.data.target.files.includes(item.file), item.file + " missing from " + JSON.stringify(body.data.target.files));
        assert(body.data.target.files.includes(item.doc), item.doc + " missing from " + JSON.stringify(body.data.target.files));
      }
    } finally {
      await server.stop();
    }
  `;
}

function changeEventsRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      const headers = { ...runtimeAuthHeaders(server.authToken), "content-type": "application/json" };
      const changesResponse = await fetch(server.url + "/api/changes", { headers });
      const changesText = await changesResponse.text();
      assert.equal(changesResponse.status, 200, changesText);
      const changesBody = JSON.parse(changesText);
      assert.equal(changesBody.data[0].id, "route-change");
      assert.equal(changesBody.data[0].boardColumn, "planned");

      const recordResponse = await fetch(server.url + "/api/changes/events", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "route-change-started-idempotent",
          changeId: "route-change",
          type: "change-started",
          summary: "Started route change.",
          actor: "test",
          files: ["src/company.ts"],
        }),
      });
      const recordText = await recordResponse.text();
      assert.equal(recordResponse.status, 200, recordText);
      const recordBody = JSON.parse(recordText);
      assert.equal(recordBody.data.event.changeIds[0], "route-change");
      assert.equal(recordBody.data.event.type, "change-started");
      assert.equal(recordBody.data.event.id, "route-change-started-idempotent");

      const retryResponse = await fetch(server.url + "/api/changes/events", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "route-change-started-idempotent",
          changeId: "route-change",
          type: "change-started",
          summary: "Started route change.",
          actor: "test",
          files: ["src/company.ts"],
        }),
      });
      const retryText = await retryResponse.text();
      assert.equal(retryResponse.status, 200, retryText);

      const eventsResponse = await fetch(server.url + "/api/changes/events?changeId=route-change", { headers });
      const eventsText = await eventsResponse.text();
      assert.equal(eventsResponse.status, 200, eventsText);
      const eventsBody = JSON.parse(eventsText);
      assert.equal(eventsBody.data[0].summary, "Started route change.");
      assert.equal(eventsBody.data.filter((event) => event.id === "route-change-started-idempotent").length, 1);

      const snapshotResponse = await fetch(server.url + "/api/snapshot", { headers });
      const snapshotText = await snapshotResponse.text();
      assert.equal(snapshotResponse.status, 200, snapshotText);
      const snapshotBody = JSON.parse(snapshotText);
      const change = snapshotBody.data.changes.find((item) => item.id === "route-change");
      assert.equal(change.boardColumn, "running");
      assert.equal(change.lastEvent.type, "change-started");
    } finally {
      await server.stop();
    }
  `;
}

function validateTraversalCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      const headers = { ...runtimeAuthHeaders(server.authToken), "content-type": "application/json" };

      for (const escaping of ["../escape.ts", "/etc/passwd"]) {
        const response = await fetch(server.url + "/api/validate", {
          method: "POST",
          headers,
          body: JSON.stringify({ files: [escaping] }),
        });
        assert.equal(response.status, 400, "escaping path " + escaping + " must be a 400, not a read");
        const body = await response.json();
        assert.equal(body.ok, false);
      }

      // A whole-project run (empty files) still succeeds — the guard only fires on supplied paths.
      const ok = await fetch(server.url + "/api/validate", {
        method: "POST",
        headers,
        body: JSON.stringify({ files: [] }),
      });
      assert.equal(ok.status, 200, await ok.text());
    } finally {
      await server.stop();
    }
  `;
}

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
      files: string[];
      relatedConventionIds: string[];
      relatedValidatorIds: string[];
      registered: boolean;
      projectState: boolean;
      projectRuntimeFile: boolean;
      registryRoots: string[];
      service: boolean;
    };
    assert.deepEqual(output.files, ["src/company.ts"]);
    assert.deepEqual(output.relatedConventionIds, ["test-rule"]);
    assert.deepEqual(output.relatedValidatorIds, ["test-rule"]);
    assert.equal(output.registered, true);
    assert.equal(output.projectRuntimeFile, true);
    assert.equal(output.projectState, true);
    assert.deepEqual(output.registryRoots, [rootDir]);
    assert.equal(output.service, true);
    assert.equal(existsSync(path.join(rootDir, ".opencanon", "state.sqlite")), true);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    await stopService(registryPath).catch(() => undefined);
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
    const output = JSON.parse(result.stdout.trim()) as { firstFiles: string[]; secondFiles: string[]; beforePid: number; afterPid: number };
    assert.deepEqual(output.firstFiles, ["src/company.ts"]);
    assert.deepEqual(output.secondFiles, ["src/company.ts"]);
    assert.notEqual(output.afterPid, output.beforePid);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    await stopService(registryPath).catch(() => undefined);
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
    const output = JSON.parse(result.stdout.trim()) as { firstFiles: string[]; secondFiles: string[]; beforePid: number; afterPid: number };
    assert.deepEqual(output.firstFiles, ["src/company.ts"]);
    assert.deepEqual(output.secondFiles, ["src/company.ts"]);
    assert.notEqual(output.afterPid, output.beforePid);
  } finally {
    await stopProjectRuntime(rootDir, registryPath).catch(() => undefined);
    await stopService(registryPath).catch(() => undefined);
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

function runtimeProjectTypesCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import path from "node:path";
    import { startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const generatedProject = path.join(rootDir, ".opencanon/generated/authoring/project.ts");
    const generatedAliases = path.join(rootDir, ".opencanon/generated/authoring/aliases.d.ts");
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      assert(readFileSync(generatedProject, "utf8").includes('DEMO_APP: "demo-app"'));
      assert(readFileSync(generatedAliases, "utf8").includes('declare module "left-pad"'));
      writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module", name: "demo-next", dependencies: { zod: "^4.0.0" } }, null, 2));
      await waitForFileText(generatedProject, (source) => source.includes('DEMO_NEXT: "demo-next"'));
      writeFileSync(path.join(rootDir, "fixtures/demo/valid.ts"), [
        'import { defineFixture } from "@opencanon/core/testing";',
        'import slugify from "slugify";',
        "",
        "void slugify;",
        "export default defineFixture({});",
        "",
      ].join("\\n"));
      await waitForFileText(generatedAliases, (source) => source.includes('declare module "slugify"'));
    } finally {
      await server.stop();
    }

    async function waitForFileText(file, predicate) {
      const deadline = Date.now() + ${RuntimeWatcherPropagationTimeoutMs};
      while (Date.now() < deadline) {
        if (existsSync(file) && predicate(readFileSync(file, "utf8"))) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Timed out waiting for generated file update: " + file);
    }
  `;
}

function runtimeValidatorReloadCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { writeFileSync } from "node:fs";
    import path from "node:path";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      assert.deepEqual(await getSnapshotValidatorIds(server.url, server.authToken), ["first-rule"]);
      writeFileSync(path.join(rootDir, "validator-helpers/rules.ts"), ${JSON.stringify(validatorHelperSource(["first-rule", "second-rule"]))});
      assert.deepEqual(await getSnapshotValidatorIds(server.url, server.authToken), ["first-rule", "second-rule"]);
      writeFileSync(path.join(rootDir, "conventions/rules.ts"), "export default { id: 1 };\\n");
      assert.deepEqual(await getSnapshotValidatorIds(server.url, server.authToken), ["first-rule", "second-rule"]);
    } finally {
      await server.stop();
    }

    async function getSnapshotValidatorIds(url, authToken) {
      const response = await fetch(url + "/api/snapshot", { headers: runtimeAuthHeaders(authToken) });
      if (response.status !== 200) throw new Error(await response.text());
      const body = await response.json();
      return body.data.validators.map((validator) => validator.id);
    }
  `;
}

function validatorHelperSource(ids: string[]): string {
  return `export const validatorIds = ${JSON.stringify(ids)};\n`;
}

function ephemeralRuntimeClientCheckSource(): string {
  const runtimeClientUrl = pathToFileURL(path.join(process.cwd(), "packages/cli/src/runtime-client.ts")).href;
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import { existsSync } from "node:fs";
    import path from "node:path";
    import { RuntimeApiRoute, withRuntimeClient } from ${JSON.stringify(runtimeClientUrl)};
    import { inspectProjectRuntime, projectRuntimePath, readRuntimeRegistry, readServiceEntry } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    if (await inspectProjectRuntime(rootDir)) throw new Error("expected no runtime before request");
    const files = await withRuntimeClient(rootDir, async (client) => {
      const snapshot = await client.get(RuntimeApiRoute.Snapshot);
      const related = await client.get(RuntimeApiRoute.CanonRelated + "?file=" + encodeURIComponent("src/company.ts"));
      return { snapshotFiles: snapshot.files, related };
    });
    console.log(JSON.stringify({
      files: files.snapshotFiles,
      relatedConventionIds: files.related.conventions.map((convention) => convention.id),
      relatedValidatorIds: files.related.validators.map((validator) => validator.id),
      registered: Boolean(await inspectProjectRuntime(rootDir)),
      projectRuntimeFile: existsSync(projectRuntimePath(rootDir)),
      projectState: existsSync(path.join(rootDir, ".opencanon", "state.sqlite")),
      registryRoots: readRuntimeRegistry().map((entry) => entry.rootDir),
      service: Boolean(readServiceEntry()),
    }));
  `;
}

function runtimeClientRepairCheckSource(): string {
  const runtimeClientUrl = pathToFileURL(path.join(process.cwd(), "packages/cli/src/runtime-client.ts")).href;
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import { RuntimeApiRoute, withRuntimeClient } from ${JSON.stringify(runtimeClientUrl)};
    import { inspectProjectRuntime, stopProjectRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const output = await withRuntimeClient(rootDir, async (client) => {
      const first = await client.get(RuntimeApiRoute.Snapshot);
      const before = await inspectProjectRuntime(rootDir);
      if (!before) throw new Error("expected registered runtime before repair");
      await stopProjectRuntime(rootDir);
      const second = await client.get(RuntimeApiRoute.Snapshot);
      const after = await inspectProjectRuntime(rootDir);
      if (!after) throw new Error("expected registered runtime after repair");
      return {
        firstFiles: first.files,
        secondFiles: second.files,
        beforePid: before.entry.pid,
        afterPid: after.entry.pid,
      };
    });
    console.log(JSON.stringify(output));
  `;
}

function runtimeClientPipeRepairCheckSource(): string {
  const runtimeClientUrl = pathToFileURL(path.join(process.cwd(), "packages/cli/src/runtime-client.ts")).href;
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import { rmSync } from "node:fs";
    import { RuntimeApiRoute, withRuntimeClient } from ${JSON.stringify(runtimeClientUrl)};
    import { inspectProjectRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const output = await withRuntimeClient(rootDir, async (client) => {
      const first = await client.get(RuntimeApiRoute.Snapshot);
      const before = await inspectProjectRuntime(rootDir);
      if (!before) throw new Error("expected registered runtime before pipe repair");
      rmSync(before.entry.pipeEndpoint, { force: true });
      const second = await client.get(RuntimeApiRoute.Snapshot);
      const after = await inspectProjectRuntime(rootDir);
      if (!after) throw new Error("expected registered runtime after pipe repair");
      return {
        firstFiles: first.files,
        secondFiles: second.files,
        beforePid: before.entry.pid,
        afterPid: after.entry.pid,
      };
    });
    console.log(JSON.stringify(output));
  `;
}
