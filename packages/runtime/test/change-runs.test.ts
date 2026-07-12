import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { ChangeCheckRunEventSchema, ChangeCheckRunEventType, ChangeCheckRunSchema, ChangeCheckRunStatus, createPaths, type ChangeCheckRunEvent } from "@opencanon/core";
import { openProjectStore, runtimeAuthHeaders, startOpenCanonRuntime } from "@opencanon/runtime";
import { createAuthoringProject } from "./support.ts";

const IntegrationTimeoutMs = 60_000;

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
    const after = stdout[0]?.sequence ?? 0;
    const replay = await readRunEvents(server.url, headers, started.id, after);
    assert(replay.every((event) => event.sequence > after));
    assert.equal(replay.at(-1)?.type, ChangeCheckRunEventType.Passed);
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
        assert.equal(response.status, 200, await response.text());
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

function createChangeRunProject(name: string, command: string): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), `opencanon-change-run-${name}-`));
  createAuthoringProject(rootDir);
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "opencanon/changes"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/example.ts"), "export const example = true;\n");
  writeFileSync(
    path.join(rootDir, "opencanon/changes/index.ts"),
    [
      'import { defineChange } from "@opencanon/core";',
      "",
      "export default defineChange({",
      `  id: ${JSON.stringify(`${name}-change`)},`,
      `  title: ${JSON.stringify(`${name} change`)},`,
      '  kind: "feature",',
      `  intent: { problem: ${JSON.stringify(`No ${name} proof`)}, outcome: ${JSON.stringify(`${name} proof runs`)} },`,
      `  checks: [{ id: ${JSON.stringify(name === "cancel" ? "long" : "stream")}, kind: "command", command: ${JSON.stringify(command)} }],`,
      '  render: { kind: "none" },',
      "});",
      "",
    ].join("\n"),
  );
  return rootDir;
}

async function startRun(url: string, headers: Record<string, string>, changeId: string, checkId: string) {
  const response = await fetch(`${url}/api/changes/check-runs`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ changeId, checkId, actor: "test" }),
  });
  const text = await response.text();
  assert.equal(response.status, 202, text);
  const payload = JSON.parse(text) as { data: { runs: unknown[] } };
  return ChangeCheckRunSchema.parse(payload.data.runs[0]);
}

async function readRun(url: string, headers: Record<string, string>, runId: string) {
  const response = await fetch(`${url}/api/changes/check-runs?runId=${encodeURIComponent(runId)}`, { headers });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const payload = JSON.parse(text) as { data: { run: unknown } };
  return ChangeCheckRunSchema.parse(payload.data.run);
}

async function readRunEvents(
  url: string,
  headers: Record<string, string>,
  runId: string,
  after = 0,
  onEvent?: (event: ChangeCheckRunEvent) => void | Promise<void>,
): Promise<ChangeCheckRunEvent[]> {
  const response = await fetch(`${url}/api/events/stream?runId=${encodeURIComponent(runId)}&after=${after}`, { headers });
  if (response.status !== 200) throw new Error(await response.text());
  const body = response.body;
  assert(body);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: ChangeCheckRunEvent[] = [];
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trimStart();
        if (!data) continue;
        const payload = JSON.parse(data) as { operation?: unknown };
        if (!payload.operation) continue;
        const event = ChangeCheckRunEventSchema.parse(payload.operation);
        if (event.runId !== runId) continue;
        events.push(event);
        await onEvent?.(event);
        if (event.type === ChangeCheckRunEventType.Passed || event.type === ChangeCheckRunEventType.Failed || event.type === ChangeCheckRunEventType.Cancelled) {
          await reader.cancel();
          return events;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`Change check run ${runId} stream ended without a terminal event.`);
}

function quotedNode(): string {
  return shellQuote(process.execPath);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
