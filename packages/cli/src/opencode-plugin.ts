import { appendOpenCodeFeedback, normalizeHookPayload, renderFeedbackMarkdown, type FeedbackResult } from "@opencanon/core";
import { RuntimeApiRoute, withRuntimeClient } from "./runtime-client.ts";

const editTools = new Set(["write", "edit", "apply_patch"]);
const FeedbackPluginHost = {
  OpenCode: "opencode",
} as const;

export const OpenCanonPlugin = async ({ directory, worktree }: { directory: string; worktree?: string }) => {
  const filesByCall = new Map<string, string[]>();
  const cwd = worktree ?? directory;

  return {
    "tool.execute.before": async (input: Record<string, unknown>, output: Record<string, unknown>) => {
      if (!editTools.has(String(input.tool))) return;
      const callId = typeof input.callID === "string" ? input.callID : "";
      if (!callId) return;
      const files = normalizeHookPayload(FeedbackPluginHost.OpenCode, { input: { ...input, cwd }, output }, cwd).files;
      if (files.length > 0) filesByCall.set(callId, files);
    },

    "tool.execute.after": async (input: Record<string, unknown>, output: Record<string, unknown>) => {
      if (!editTools.has(String(input.tool))) return;
      const callId = typeof input.callID === "string" ? input.callID : "";
      const beforeFiles = callId ? (filesByCall.get(callId) ?? []) : [];
      if (callId) filesByCall.delete(callId);

      const event = {
        input: { ...input, cwd },
        output,
      };
      const afterFiles = normalizeHookPayload(FeedbackPluginHost.OpenCode, event, cwd).files;
      const files = [...new Set([...beforeFiles, ...afterFiles])];
      if (files.length === 0) return;

      const result = await withRuntimeClient(cwd, (client) =>
        client.post<FeedbackResult>(RuntimeApiRoute.Feedback, {
          files,
          host: FeedbackPluginHost.OpenCode,
          sessionId: typeof input.sessionID === "string" ? input.sessionID : undefined,
          turnId: callId || undefined,
          dedupeScope: "turn",
        }),
      );
      appendOpenCodeFeedback(output, renderFeedbackMarkdown(result, { maxFindings: 20, maxChars: 6000 }));
    },
  };
};
