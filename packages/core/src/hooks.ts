import path from "node:path";
import { FeedbackHost, renderFeedbackMarkdown, runFeedback } from "./feedback.ts";
import type { FeedbackResult } from "./feedback.ts";
import { unique } from "./core.ts";

export type HookFeedback = {
  host: FeedbackHost;
  cwd: string;
  files: string[];
  sessionId?: string;
  turnId?: string;
  result: FeedbackResult;
  text: string;
};

export async function createHookFeedback(host: FeedbackHost, payload: unknown, cwdFallback = process.cwd()): Promise<HookFeedback> {
  const event = normalizeHookPayload(host, payload, cwdFallback);
  const result = await runFeedback({
    cwd: event.cwd,
    files: event.files,
    host,
    sessionId: event.sessionId,
    turnId: event.turnId,
    dedupeScope: "turn",
  });
  return {
    ...event,
    host,
    result,
    text: renderFeedbackMarkdown(result, { maxFindings: 20, maxChars: 6000 }),
  };
}

export function renderHookResponse(feedback: HookFeedback): string {
  if (!feedback.text) return "";
  if (feedback.host === FeedbackHost.Codex) return renderCodexResponse(feedback.text);
  if (feedback.host === FeedbackHost.Claude) return renderClaudeResponse(feedback.text);
  if (feedback.host === FeedbackHost.OpenCode) {
    return JSON.stringify(
      {
        additionalContext: feedback.text,
        result: feedback.result,
      },
      null,
      2,
    );
  }
  return feedback.text;
}

export function appendOpenCodeFeedback(output: unknown, text: string): void {
  if (!text || !isRecord(output)) return;
  const current = typeof output.output === "string" ? output.output : "";
  output.output = [current, text].filter(Boolean).join("\n\n");
}

export function normalizeHookPayload(
  host: FeedbackHost,
  payload: unknown,
  cwdFallback = process.cwd(),
): { cwd: string; files: string[]; sessionId?: string; turnId?: string } {
  if (host === FeedbackHost.OpenCode && isRecord(payload) && isRecord(payload.input) && isRecord(payload.output)) {
    return normalizeOpenCodePayload({ input: payload.input, output: payload.output }, cwdFallback);
  }

  const record = isRecord(payload) ? payload : {};
  const toolInput = isRecord(record.tool_input) ? record.tool_input : {};
  const toolResponse = isRecord(record.tool_response) ? record.tool_response : {};
  const cwd = stringValue(record.cwd) ?? cwdFallback;
  const files = unique([
    ...extractKnownFileFields(toolInput),
    ...extractKnownFileFields(toolResponse),
    ...extractFilesFromPatchText(stringValue(toolInput.command) ?? ""),
    ...extractFilesFromPatchText(stringValue(toolInput.patch) ?? ""),
    ...extractFilesFromPatchText(stringValue(toolInput.patchText) ?? ""),
  ]);

  return {
    cwd,
    files,
    sessionId: stringValue(record.session_id),
    turnId: stringValue(record.turn_id),
  };
}

export function extractFilesFromPatchText(value: string): string[] {
  if (!value) return [];
  const files: string[] = [];
  const markerPattern = /^\*\*\* (?:Add|Update) File: (.+)$/gm;
  const movePattern = /^\*\*\* Move to: (.+)$/gm;

  for (const match of value.matchAll(markerPattern)) {
    const file = cleanPatchPath(match[1]);
    if (file) files.push(file);
  }
  for (const match of value.matchAll(movePattern)) {
    const file = cleanPatchPath(match[1]);
    if (file) files.push(file);
  }

  return unique(files);
}

function normalizeOpenCodePayload(
  payload: { input: Record<string, unknown>; output: Record<string, unknown> },
  cwdFallback: string,
): { cwd: string; files: string[]; sessionId?: string; turnId?: string } {
  const args = isRecord(payload.output.args) ? payload.output.args : {};
  const files = unique([
    ...extractKnownFileFields(args),
    ...extractKnownFileFields(payload.input),
    ...extractFilesFromPatchText(stringValue(args.patchText) ?? ""),
    ...extractFilesFromPatchText(stringValue(args.patch) ?? ""),
  ]);
  const cwd = stringValue(payload.input.cwd) ?? stringValue(payload.output.cwd) ?? cwdFallback;

  return {
    cwd,
    files,
    sessionId: stringValue(payload.input.sessionID) ?? stringValue(payload.input.sessionId),
    turnId: stringValue(payload.input.callID),
  };
}

function extractKnownFileFields(value: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const key of ["file_path", "filePath", "path", "targetFile", "target_file", "notebook_path"]) {
    const file = stringValue(value[key]);
    if (file) files.push(file);
  }

  if (Array.isArray(value.files)) {
    for (const file of value.files) {
      if (typeof file === "string") files.push(file);
      else if (isRecord(file)) files.push(...extractKnownFileFields(file));
    }
  }

  if (Array.isArray(value.edits)) {
    for (const edit of value.edits) {
      if (isRecord(edit)) files.push(...extractKnownFileFields(edit));
    }
  }

  return unique(files.map(normalizeInputPath).filter(Boolean));
}

function renderCodexResponse(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: text,
    },
  });
}

function renderClaudeResponse(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: text,
    },
  });
}

function cleanPatchPath(value: string | undefined): string | null {
  if (!value) return null;
  return normalizeInputPath(value.replace(/\t.*$/, "").trim());
}

function normalizeInputPath(value: string): string {
  return value.replace(/^["']|["']$/g, "").split(path.sep).join("/");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
