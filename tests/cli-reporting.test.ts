import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "vitest";
import { ChangeCheckRunEventType, ChangeCheckRunSchema, ChangeCheckRunStatus, createPaths } from "@opencanon/core";
import {
  compareAndSetRuntimeLifecycle,
  openProjectStore,
  ProcessLifecycleStatus,
  projectRuntimeStatePath,
  readProjectRuntimeEntry,
  runtimeNamespaceForRegistry,
} from "@opencanon/runtime";
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

test("search fails when Project Knowledge is not ready", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-search-knowledge-"));
  try {
    createAuthoringProject(rootDir);
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = 'active';\n");

    const result = spawnSync(process.execPath, [script, "search", "company", "--kind", "context", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env: testEnv(rootDir),
      timeout: CliSpawnTimeoutMs,
    });

    assert.equal(result.error, undefined, result.error ? result.error.message : "spawn failed");
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /Project Knowledge search failed:/);
  } finally {
    removeTestRoot(rootDir);
  }
}, CliSpawnTimeoutMs);

test("doctor waits for active project work before inspecting runtime state", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-doctor-ready-"));
  const registryPath = path.join(rootDir, "global", "service.json");
  try {
    createAuthoringProject(rootDir);
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = 'active';\n");

    const started = spawnSync(process.execPath, [script, "project", "start", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env: testEnv(rootDir),
      timeout: CliSpawnTimeoutMs,
    });
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const entry = readProjectRuntimeEntry(rootDir, registryPath);
    assert(entry, "project runtime was not registered");
    const busy = compareAndSetRuntimeLifecycle(
      entry,
      {
        ...entry.lifecycle,
        status: ProcessLifecycleStatus.Busy,
        updatedAt: new Date().toISOString(),
        message: "Test project work is active.",
      },
      registryPath,
    );
    assert.equal(busy.applied, true, "project runtime did not enter the test busy state");

    const doctorStartedAt = Date.now();
    const doctorPromise = runCliProcess(rootDir, ["doctor", "--format", "json"]);
    await delay(350);

    const activeEntry = readProjectRuntimeEntry(rootDir, registryPath);
    assert(activeEntry, "project runtime registration disappeared while Doctor waited");
    const running = compareAndSetRuntimeLifecycle(
      activeEntry,
      {
        ...activeEntry.lifecycle,
        status: ProcessLifecycleStatus.Running,
        updatedAt: new Date().toISOString(),
        message: "Test project work completed.",
      },
      registryPath,
    );
    assert.equal(running.applied, true, "project runtime did not leave the test busy state");

    const doctor = await doctorPromise;
    assert(Date.now() - doctorStartedAt >= 300, "Doctor returned before active project work settled");
    assert([0, 1].includes(doctor.status ?? -1), doctor.stderr || doctor.stdout);
    const payload = JSON.parse(doctor.stdout) as { checks: Array<{ id: string; status: string; message: string }> };
    assert.equal(payload.checks.find((check) => check.id === "runtime-health")?.status, "pass");
    assert.notEqual(payload.checks.find((check) => check.id === "semantic-index")?.status, "fail");
  } finally {
    removeTestRoot(rootDir);
  }
}, CliSpawnTimeoutMs);

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

    const doctor = spawnSync(process.execPath, [script, "doctor", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env: testEnv(rootDir),
      timeout: CliSpawnTimeoutMs,
    });
    assert.equal(doctor.error, undefined, doctor.error ? doctor.error.message : "spawn failed");
    assert([0, 1].includes(doctor.status ?? -1), doctor.stderr || doctor.stdout);
    const doctorPayload = JSON.parse(doctor.stdout) as { checks: Array<{ id: string; status: string; message: string }> };
    const knowledgeCheck = doctorPayload.checks.find((check) => check.id === "semantic-index");
    assert.equal(knowledgeCheck?.status, "warn");
    assert.match(knowledgeCheck?.message ?? "", /snapshot|built|stale/i);

    const check = spawnSync(process.execPath, [script, "changes", "check", "cli-task-change", "--task", "model", "--all", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env: testEnv(rootDir),
      timeout: 30_000,
    });
    assert.equal(check.status, 0, check.stderr || check.stdout);
    const checkPayload = JSON.parse(check.stdout) as { runs: Array<{ id: string; taskId?: string; checkId: string; status: string }> };
    assert.deepEqual(checkPayload.runs.map((item) => `${item.taskId}:${item.checkId}:${item.status}`), ["model:smoke:passed"]);
    const runId = checkPayload.runs[0]!.id;

    const listedRuns = spawnSync(process.execPath, [script, "changes", "runs", "list", "--status", "passed", "--limit", "1", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env: testEnv(rootDir),
      timeout: CliSpawnTimeoutMs,
    });
    assert.equal(listedRuns.status, 0, listedRuns.stderr || listedRuns.stdout);
    const listedRunsPayload = JSON.parse(listedRuns.stdout) as { runs: Array<{ id: string; status: string }> };
    assert.deepEqual(listedRunsPayload.runs.map((run) => `${run.id}:${run.status}`), [`${runId}:passed`]);

    const shownRun = spawnSync(process.execPath, [script, "changes", "runs", "show", runId, "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env: testEnv(rootDir),
      timeout: CliSpawnTimeoutMs,
    });
    assert.equal(shownRun.status, 0, shownRun.stderr || shownRun.stdout);
    const shownRunPayload = JSON.parse(shownRun.stdout) as { run: { id: string; status: string }; latestSequence: number };
    assert.equal(shownRunPayload.run.id, runId);
    assert.equal(shownRunPayload.run.status, "passed");
    assert(shownRunPayload.latestSequence > 0);

    const watchedRun = spawnSync(process.execPath, [script, "changes", "runs", "watch", runId, "--after", "0", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env: testEnv(rootDir),
      timeout: CliSpawnTimeoutMs,
    });
    assert.equal(watchedRun.status, 0, watchedRun.stderr || watchedRun.stdout);
    const watchedRunPayload = JSON.parse(watchedRun.stdout) as { run: { id: string; status: string } };
    assert.equal(watchedRunPayload.run.id, runId);
    assert.equal(watchedRunPayload.run.status, "passed");

    const cancelledTerminalRun = spawnSync(process.execPath, [script, "changes", "runs", "cancel", runId, "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env: testEnv(rootDir),
      timeout: CliSpawnTimeoutMs,
    });
    assert.equal(cancelledTerminalRun.status, 0, cancelledTerminalRun.stderr || cancelledTerminalRun.stdout);
    const cancelledTerminalPayload = JSON.parse(cancelledTerminalRun.stdout) as { run: { id: string; status: string } };
    assert.equal(cancelledTerminalPayload.run.id, runId);
    assert.equal(cancelledTerminalPayload.run.status, "passed");

    const events = spawnSync(process.execPath, [script, "changes", "events", "cli-task-change", "--task", "model", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env: testEnv(rootDir),
      timeout: CliSpawnTimeoutMs,
    });
    assert.equal(events.status, 0, events.stderr || events.stdout);
    const eventPayload = JSON.parse(events.stdout) as { events: Array<{ type: string; taskIds: string[]; checkIds: string[] }> };
    const passed = eventPayload.events.find((event) => event.type === "task-check-passed");
    assert.deepEqual(passed?.taskIds, ["model"]);
    assert.deepEqual(passed?.checkIds, ["smoke"]);
  } finally {
    removeTestRoot(rootDir);
  }
}, CliSpawnTimeoutMs);

test("changes runs watch pages replay beyond one event frame", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-cli-run-replay-"));
  try {
    createAuthoringProject(rootDir);
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
    const timestamp = new Date().toISOString();
    const run = ChangeCheckRunSchema.parse({
      id: "paged-run",
      batchId: "paged-batch",
      kind: "change-check",
      status: ChangeCheckRunStatus.Passed,
      changeId: "paged-change",
      checkId: "paged-check",
      checkKind: "command",
      executor: { runtimeNamespace: "test", leaseId: "cli-reporting" },
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
      summary: "Check passed.",
      outputTail: "x",
      outputBytes: 2_099,
      outputTruncated: false,
    });
    const registryPath = path.join(rootDir, "global", "service.json");
    const store = openProjectStore({
      rootDir,
      paths: createPaths(rootDir),
      statePath: projectRuntimeStatePath(rootDir, runtimeNamespaceForRegistry(registryPath)),
    });
    try {
      store.writeJob(run);
      store.appendJobEvent({ runId: run.id, batchId: run.batchId, timestamp, type: ChangeCheckRunEventType.Queued });
      for (let sequence = 2; sequence <= 2_100; sequence += 1) {
        store.appendJobEvent({ runId: run.id, batchId: run.batchId, timestamp, type: ChangeCheckRunEventType.Stdout, text: "x" });
      }
      store.appendJobEvent({ runId: run.id, batchId: run.batchId, timestamp, type: ChangeCheckRunEventType.Passed, run });
    } finally {
      store.close();
    }

    const watched = spawnSync(process.execPath, [script, "changes", "runs", "watch", run.id, "--after", "0", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env: testEnv(rootDir),
      timeout: CliSpawnTimeoutMs,
    });
    assert.equal(watched.status, 0, watched.stderr || watched.stdout);
    assert.equal(watched.stderr, "x".repeat(2_099));
    const payload = JSON.parse(watched.stdout) as { run: { id: string; status: string }; latestSequence: number };
    assert.equal(payload.run.id, run.id);
    assert.equal(payload.run.status, ChangeCheckRunStatus.Passed);
    assert.equal(payload.latestSequence, 2_101);
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
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: rootDir,
      encoding: "utf8",
      env,
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
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

function runCliProcess(rootDir: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: rootDir,
      env: testEnv(rootDir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`OpenCanon CLI process timed out after ${CliSpawnTimeoutMs}ms.`));
    }, CliSpawnTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
