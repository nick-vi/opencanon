import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { ChangeCheckRunEventSchema, ChangeCheckRunEventType, ChangeCheckRunSchema, ChangeCheckRunStatus, ChangeCheckTimeout, createPaths, resolveChangeCheckTimeoutMs, type ChangeCheckRunEvent } from "@opencanon/core";
import { openProjectStore, runtimeAuthHeaders, startOpenCanonRuntime } from "@opencanon/runtime";
import { createAuthoringProject } from "./support.ts";
import { createChangeRunProject, quotedNode, readRunEvents, shellQuote, startRun } from "./change-run-test-support.ts";
import { ChangeCheckRunPolicy } from "../src/change-check-runner.ts";

const IntegrationTimeoutMs = 60_000;

test("Change check timeout budgets are bounded", () => {
  assert.equal(resolveChangeCheckTimeoutMs({ id: "default", kind: "command", command: "true" }), ChangeCheckTimeout.DefaultMs);
  assert.equal(resolveChangeCheckTimeoutMs({ id: "custom", kind: "test", target: "tests/example.test.ts", timeoutMs: 600_000 }), 600_000);
  assert.throws(
    () => resolveChangeCheckTimeoutMs({ id: "short", kind: "command", command: "true", timeoutMs: ChangeCheckTimeout.MinimumMs - 1 }),
    /timeoutMs must be an integer/,
  );
  assert.throws(
    () => resolveChangeCheckTimeoutMs({ id: "long", kind: "command", command: "true", timeoutMs: ChangeCheckTimeout.MaximumMs + 1 }),
    /timeoutMs must be an integer/,
  );
});

test("Change check admission rejects an oversized batch without persisting a partial run", { timeout: IntegrationTimeoutMs }, async () => {
  const rootDir = createCapacityProject(ChangeCheckRunPolicy.activeCapacity + 1);
  const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
  try {
    const response = await fetch(`${server.url}/api/changes/check-runs`, {
      method: "POST",
      headers: { ...runtimeAuthHeaders(server.authToken), "content-type": "application/json" },
      body: JSON.stringify({ changeId: "capacity-change", all: true, actor: "test" }),
    });
    const payload = JSON.parse(await response.text()) as { error?: { diagnostics?: Array<{ code: string }> } };
    assert.equal(response.status, 429);
    assert.equal(payload.error?.diagnostics?.[0]?.code, "operation-capacity-exceeded");

    const store = openProjectStore({ rootDir, paths: createPaths(rootDir) });
    try {
      assert.deepEqual(store.listJobs({ mode: "recent", limit: 50 }), []);
    } finally {
      store.close();
    }
  } finally {
    await server.stop();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime startup applies terminal run age and count retention", { timeout: IntegrationTimeoutMs }, async () => {
  const rootDir = createChangeRunProject("retention", `${quotedNode()} -e ${shellQuote("process.exit(0)")}`);
  const paths = createPaths(rootDir);
  const seededStore = openProjectStore({ rootDir, paths });
  try {
    seededStore.writeJob(terminalRun("expired", new Date(Date.now() - ChangeCheckRunPolicy.terminalRetentionAgeMs - 60_000).toISOString()));
    for (let index = 0; index <= ChangeCheckRunPolicy.terminalRetentionCount; index += 1) {
      seededStore.writeJob(terminalRun(`recent-${String(index).padStart(3, "0")}`, new Date(Date.now() - index * 1_000).toISOString()));
    }
  } finally {
    seededStore.close();
  }

  const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
  try {
    const store = openProjectStore({ rootDir, paths });
    try {
      const retained = store.listJobs({ mode: "recent", limit: 500 });
      assert.equal(retained.length, ChangeCheckRunPolicy.terminalRetentionCount);
      assert.equal(store.readJob("expired"), null);
      assert.equal(store.readJob(`recent-${String(ChangeCheckRunPolicy.terminalRetentionCount).padStart(3, "0")}`), null);
      assert(store.readJob("recent-000"));
    } finally {
      store.close();
    }
  } finally {
    await server.stop();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Change check runs stream output, persist terminal state, and replay from a cursor", { timeout: IntegrationTimeoutMs }, async () => {
  const rootDir = createChangeRunProject("replay", `${quotedNode()} -e ${shellQuote("console.log(process.env.OPENCANON_SERVICE_REGISTRY_PATH); console.log('first'); setTimeout(() => console.log('second'), 100)")}`);
  const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
  try {
    const headers = runtimeAuthHeaders(server.authToken);
    const started = await startRun(server.url, headers, "replay-change", "stream");
    assert.equal(started.status, ChangeCheckRunStatus.Queued);

    const events = await readRunEvents(server.url, headers, started.id);
    const stdout = events.filter((event) => event.type === ChangeCheckRunEventType.Stdout);
    const terminal = events.at(-1);
    assert(stdout.some((event) => "text" in event && event.text.includes("first")));
    assert(stdout.some((event) => "text" in event && event.text.includes("second")));
    assert.equal(terminal?.type, ChangeCheckRunEventType.Passed);
    assert(terminal && "run" in terminal);
    if (terminal && "run" in terminal) {
      assert.equal(terminal.run.status, ChangeCheckRunStatus.Passed);
      assert.match(terminal.run.outputTail, /first/);
      assert.match(terminal.run.outputTail, /second/);
      assert.match(terminal.run.outputTail, /\.opencanon\/check-/);
    }

    const persisted = await readRun(server.url, headers, started.id);
    assert.equal(persisted.status, ChangeCheckRunStatus.Passed);
    const listedResponse = await fetch(`${server.url}/api/changes/check-runs?status=passed&limit=1`, { headers });
    const listedText = await listedResponse.text();
    assert.equal(listedResponse.status, 200, listedText);
    const listedPayload = JSON.parse(listedText) as { data: { runs: unknown[] } };
    assert.deepEqual(listedPayload.data.runs.map((run) => ChangeCheckRunSchema.parse(run).id), [started.id]);
    const snapshotResponse = await fetch(`${server.url}/api/changes/check-runs?runId=${encodeURIComponent(started.id)}&after=0`, { headers });
    const snapshotText = await snapshotResponse.text();
    assert.equal(snapshotResponse.status, 200, snapshotText);
    const snapshotPayload = JSON.parse(snapshotText) as { data: { run: unknown; latestSequence: number; events: unknown[] } };
    assert.equal(ChangeCheckRunSchema.parse(snapshotPayload.data.run).id, started.id);
    assert(snapshotPayload.data.latestSequence >= events.at(-1)!.sequence);
    assert.equal(snapshotPayload.data.events.at(-1) && ChangeCheckRunEventSchema.parse(snapshotPayload.data.events.at(-1)).type, ChangeCheckRunEventType.Passed);
    const after = stdout[0]?.sequence ?? 0;
    const replay = await readRunEvents(server.url, headers, started.id, after);
    assert(replay.every((event) => event.sequence > after));
    assert.equal(replay.at(-1)?.type, ChangeCheckRunEventType.Passed);
  } finally {
    await server.stop();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime idle shutdown waits for active Change checks", { timeout: IntegrationTimeoutMs }, async () => {
  const rootDir = createChangeRunProject(
    "idle",
    `${quotedNode()} -e ${shellQuote("setTimeout(() => console.log('finished'), 700)")}`,
  );
  let resolveIdle!: () => void;
  let idleCalled = false;
  const idle = new Promise<void>((resolve) => {
    resolveIdle = () => {
      idleCalled = true;
      resolve();
    };
  });
  const server = await startOpenCanonRuntime({
    cwd: rootDir,
    port: 0,
    idleTimeoutMs: 500,
    onIdle: resolveIdle,
  });
  try {
    const headers = runtimeAuthHeaders(server.authToken);
    const started = await startRun(server.url, headers, "idle-change", "stream");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(idleCalled, false, "active work must prevent idle shutdown");

    const events = await readRunEvents(server.url, headers, started.id);
    assert.equal(events.at(-1)?.type, ChangeCheckRunEventType.Passed);
    await Promise.race([
      idle,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("runtime did not stop after becoming idle")), 2_000)),
    ]);
  } finally {
    await server.stop();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Change check output preserves UTF-8 at persisted and tail byte limits", { timeout: IntegrationTimeoutMs }, async () => {
  const characterCount = 300_000;
  const rootDir = createChangeRunProject(
    "utf8",
    `${quotedNode()} -e ${shellQuote(`process.stdout.write('\\u{1F642}'.repeat(${characterCount}))`)}`,
  );
  const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
  try {
    const headers = runtimeAuthHeaders(server.authToken);
    const started = await startRun(server.url, headers, "utf8-change", "stream");
    const events = await readRunEvents(server.url, headers, started.id);
    const output = events
      .filter((event): event is Extract<ChangeCheckRunEvent, { type: "stdout" }> => event.type === ChangeCheckRunEventType.Stdout)
      .map((event) => event.text)
      .join("");
    const terminal = events.at(-1);
    assert(terminal && "run" in terminal);
    if (!terminal || !("run" in terminal)) throw new Error("Expected terminal Change check run.");

    assert.equal(terminal.run.status, ChangeCheckRunStatus.Passed);
    assert.equal(terminal.run.outputBytes, characterCount * 4);
    assert.equal(terminal.run.outputTruncated, true);
    assert.equal(Buffer.byteLength(output, "utf8"), 1024 * 1024);
    assert.equal(Buffer.byteLength(terminal.run.outputTail, "utf8"), 64 * 1024);
    assert.equal(output.includes("\uFFFD"), false);
    assert.equal(terminal.run.outputTail.includes("\uFFFD"), false);
  } finally {
    await server.stop();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Change check cancellation terminates the command and persists cancelled state", { timeout: IntegrationTimeoutMs }, async () => {
  const rootDir = createChangeRunProject("cancel", `${quotedNode()} -e ${shellQuote("require('node:fs').writeFileSync('child.pid', String(process.pid)); console.log('ready-to-cancel'); setInterval(() => {}, 1000)")}`);
  const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
  try {
    const headers = runtimeAuthHeaders(server.authToken);
    const started = await startRun(server.url, headers, "cancel-change", "long");
    let cancelled = false;
    const events = await readRunEvents(server.url, headers, started.id, 0, async (event) => {
      if (!cancelled && event.type === ChangeCheckRunEventType.Stdout && event.text.includes("ready-to-cancel")) {
        cancelled = true;
        const response = await fetch(`${server.url}/api/changes/check-runs/cancel`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ runId: started.id }),
        });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        const payload = JSON.parse(text) as { data: { run: unknown } };
        assert.equal(ChangeCheckRunSchema.parse(payload.data.run).status, ChangeCheckRunStatus.Cancelled);
      }
    });
    assert.equal(cancelled, true);
    assert.equal(events.at(-1)?.type, ChangeCheckRunEventType.Cancelled);
    assert.equal((await readRun(server.url, headers, started.id)).status, ChangeCheckRunStatus.Cancelled);
    const childPid = Number(readFileSync(path.join(rootDir, "child.pid"), "utf8"));
    assert.throws(() => process.kill(childPid, 0));
  } finally {
    await server.stop();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Change check command failures preserve stderr and exit code", { timeout: IntegrationTimeoutMs }, async () => {
  const rootDir = createChangeRunProject("failure", `${quotedNode()} -e ${shellQuote("console.error('expected failure'); process.exit(7)")}`);
  const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
  try {
    const headers = runtimeAuthHeaders(server.authToken);
    const started = await startRun(server.url, headers, "failure-change", "stream");
    const events = await readRunEvents(server.url, headers, started.id);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, ChangeCheckRunEventType.Failed);
    assert(terminal && "run" in terminal);
    if (terminal && "run" in terminal) {
      assert.equal(terminal.run.status, ChangeCheckRunStatus.Failed);
      assert.equal(terminal.run.exitCode, 7);
      assert.match(terminal.run.outputTail, /expected failure/);
    }
  } finally {
    await server.stop();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Change check commands honor their declared timeout budget", { timeout: IntegrationTimeoutMs }, async () => {
  const rootDir = createChangeRunProject(
    "timeout",
    `${quotedNode()} -e ${shellQuote("setTimeout(() => process.exit(0), 1000)")}`,
    100,
  );
  const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
  try {
    const headers = runtimeAuthHeaders(server.authToken);
    const started = await startRun(server.url, headers, "timeout-change", "stream");
    const events = await readRunEvents(server.url, headers, started.id);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, ChangeCheckRunEventType.Failed);
    assert(terminal && "run" in terminal);
    if (terminal && "run" in terminal) {
      assert.equal(terminal.run.status, ChangeCheckRunStatus.Failed);
      assert.match(terminal.run.summary, /timed out after 100ms/);
    }
  } finally {
    await server.stop();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime startup finalizes persisted non-terminal Change check runs as interrupted", { timeout: IntegrationTimeoutMs }, async () => {
  const rootDir = createChangeRunProject("interrupted", `${quotedNode()} -e ${shellQuote("process.exit(0)")}`);
  const run = ChangeCheckRunSchema.parse({
    id: "interrupted-run",
    batchId: "interrupted-batch",
    kind: "change-check",
    status: ChangeCheckRunStatus.Running,
    changeId: "interrupted-change",
    checkId: "stream",
    checkKind: "command",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:01.000Z",
    startedAt: "2026-07-12T00:00:01.000Z",
    outputTail: "partial",
    outputBytes: 7,
    outputTruncated: false,
  });
  const store = openProjectStore({ rootDir, paths: createPaths(rootDir) });
  store.writeJob(run);
  store.close();
  const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
  try {
    const recovered = await readRun(server.url, runtimeAuthHeaders(server.authToken), run.id);
    assert.equal(recovered.status, ChangeCheckRunStatus.Failed);
    assert("interrupted" in recovered && recovered.interrupted);
  } finally {
    await server.stop();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function createCapacityProject(checkCount: number): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-change-run-capacity-"));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "opencanon/changes"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/example.ts"), "export const example = true;\n");
  const checks = Array.from({ length: checkCount }, (_, index) => ({
    id: `check-${index + 1}`,
    kind: "command",
    command: `${quotedNode()} -e ${shellQuote("process.exit(0)")}`,
  }));
  writeFileSync(
    path.join(rootDir, "opencanon/changes/index.ts"),
    [
      'import { defineChange } from "@opencanon/core";',
      "",
      "export default defineChange({",
      '  id: "capacity-change",',
      '  title: "Capacity change",',
      '  kind: "feature",',
      '  intent: { problem: "Operation pressure", outcome: "Admission remains bounded" },',
      `  checks: ${JSON.stringify(checks)},`,
      '  render: { kind: "none" },',
      "});",
      "",
    ].join("\n"),
  );
  return rootDir;
}

function terminalRun(id: string, timestamp: string) {
  return ChangeCheckRunSchema.parse({
    id,
    batchId: "retention-batch",
    kind: "change-check",
    status: ChangeCheckRunStatus.Passed,
    changeId: "retention-change",
    checkId: "stream",
    checkKind: "command",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    summary: "Passed.",
    outputTail: "",
    outputBytes: 0,
    outputTruncated: false,
  });
}

async function readRun(url: string, headers: Record<string, string>, runId: string) {
  const response = await fetch(`${url}/api/changes/check-runs?runId=${encodeURIComponent(runId)}`, { headers });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const payload = JSON.parse(text) as { data: { run: unknown } };
  return ChangeCheckRunSchema.parse(payload.data.run);
}
