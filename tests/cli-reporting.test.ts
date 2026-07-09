import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "vitest";
import { createAuthoringProject } from "../packages/runtime/test/support.ts";

const script = path.join(process.cwd(), "packages/cli/src/index.ts");
const CliSpawnTimeoutMs = 60_000;

test("languages command exposes the explicit capability matrix", () => {
  const result = spawnSync(process.execPath, [script, "languages", "--format", "json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout) as {
    languages: Array<{ id: string; parser: string; graph: string; facts: { available: string[]; derived: string[] } }>;
  };
  const typescript = payload.languages.find((language) => language.id === "typescript");
  const python = payload.languages.find((language) => language.id === "python");
  const markdown = payload.languages.find((language) => language.id === "markdown");
  assert.equal(typescript?.parser, "oxc");
  assert(typescript?.facts.derived.includes("references"));
  assert.equal(python?.parser, "rustpython");
  assert.equal(markdown?.parser, "none");
  assert.equal(markdown?.graph, "none");
});

test("review command produces a deterministic local CI report", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-review-"));
  try {
    createAuthoringProject(rootDir);
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = 'active';\n");

    const result = spawnSync(process.execPath, [script, "review", "--files", "src/company.ts", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env: testEnv(rootDir),
      timeout: CliSpawnTimeoutMs,
    });

    assert.equal(result.error, undefined, result.error ? result.error.message : "spawn failed");
    assert([0, 1].includes(result.status ?? -1), result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as {
      rootDir: string;
      files: string[];
      doctor: { status: string };
      validation: { files: string[]; findings: unknown[] } | null;
      externalTools: { configured: number; checked: boolean };
    };
    assert.equal(payload.rootDir, realpathSync(rootDir));
    assert.deepEqual(payload.files, ["src/company.ts"]);
    assert(payload.doctor.status);
    assert.deepEqual(payload.validation?.files, ["src/company.ts"]);
    assert.deepEqual(payload.validation?.findings, []);
    assert.equal(payload.externalTools.checked, false);
  } finally {
    removeTestRoot(rootDir);
  }
});

test("changes ready and brief expose agent-ready task work", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-cli-changes-"));
  try {
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
        "  id: \"cli-task-change\",",
        "  title: \"CLI Task Change\",",
        "  kind: \"feature\",",
        "  intent: { problem: \"No CLI task workflow\", outcome: \"CLI task workflow works\" },",
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

    const ready = spawnSync(process.execPath, [script, "changes", "ready", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env: testEnv(rootDir),
      timeout: CliSpawnTimeoutMs,
    });
    assert.equal(ready.status, 0, ready.stderr || ready.stdout);
    const queue = JSON.parse(ready.stdout) as { ready: Array<{ changeId: string; taskId?: string; surfaces: string[]; suggestedCommands: string[] }>; blocked: Array<{ taskId?: string }> };
    assert.deepEqual(queue.ready.map((item) => `${item.changeId}/${item.taskId}`), ["cli-task-change/model"]);
    assert.deepEqual(queue.ready[0].surfaces, ["company-workflow"]);
    assert(queue.ready[0].suggestedCommands.some((command) => command.includes("opencanon context --files src/company.ts")));
    assert.deepEqual(queue.blocked.map((item) => item.taskId), ["cli"]);

    const brief = spawnSync(process.execPath, [script, "brief", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env: testEnv(rootDir),
      timeout: CliSpawnTimeoutMs,
    });
    assert.equal(brief.status, 0, brief.stderr || brief.stdout);
    const briefPayload = JSON.parse(brief.stdout) as { queue: { ready: Array<{ taskId?: string; surfaces: string[] }> }; packet: { xml: string; mode: string }; nextActions: Array<{ command: string }> };
    assert.equal(briefPayload.packet.mode, "agent-brief");
    assert.deepEqual(briefPayload.queue.ready.map((item) => item.taskId), ["model"]);
    assert.deepEqual(briefPayload.queue.ready[0].surfaces, ["company-workflow"]);
    assert(briefPayload.nextActions.some((action) => action.command.includes("opencanon changes claim cli-task-change --task model")));
    assert.match(briefPayload.packet.xml, /<ready-work>/);
    assert.match(briefPayload.packet.xml, /surface id="company-workflow"/);

    const check = spawnSync(process.execPath, [script, "changes", "check", "cli-task-change", "--task", "model", "--all", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env: testEnv(rootDir),
      timeout: 30_000,
    });
    assert.equal(check.status, 0, check.stderr || check.stdout);
    const checkPayload = JSON.parse(check.stdout) as { results: Array<{ taskId?: string; status: string }>; event: { taskIds: string[]; checkIds: string[] } };
    assert.deepEqual(checkPayload.results.map((item) => `${item.taskId}:${item.status}`), ["model:passed"]);
    assert.deepEqual(checkPayload.event.taskIds, ["model"]);
    assert.deepEqual(checkPayload.event.checkIds, ["smoke"]);
  } finally {
    removeTestRoot(rootDir);
  }
}, CliSpawnTimeoutMs);

function removeTestRoot(rootDir: string): void {
  stopTestRuntime(rootDir);
  rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function stopTestRuntime(rootDir: string): void {
  const env = testEnv(rootDir);
  for (const args of [
    ["project", "stop", "--format", "json"],
    ["service", "stop", "--format", "json"],
  ]) {
    spawnSync(process.execPath, [script, ...args], {
      cwd: rootDir,
      encoding: "utf8",
      env,
      timeout: 15_000,
    });
  }
}

function testEnv(rootDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.OPENCANON_SERVICE_REGISTRY_PATH = path.join(rootDir, "global", "service.json");
  return env;
}
