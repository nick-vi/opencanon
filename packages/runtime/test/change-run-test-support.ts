import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ChangeCheckRunEventSchema,
  ChangeCheckRunEventType,
  ChangeCheckRunSchema,
  type ChangeCheckRunEvent,
} from "@opencanon/core";
import { createAuthoringProject } from "./support.ts";

export function createChangeRunProject(name: string, command: string, timeoutMs?: number): string {
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
      `  checks: [{ id: ${JSON.stringify(name === "cancel" ? "long" : "stream")}, kind: "command", command: ${JSON.stringify(command)}${timeoutMs === undefined ? "" : `, timeoutMs: ${timeoutMs}`} }],`,
      '  render: { kind: "none" },',
      "});",
      "",
    ].join("\n"),
  );
  return rootDir;
}

export async function startRun(url: string, headers: Record<string, string>, changeId: string, checkId: string) {
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

export async function readRunEvents(
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

export function quotedNode(): string {
  return shellQuote(process.execPath);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
