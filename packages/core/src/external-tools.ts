import type { ExternalTool, ExternalToolMissingSeverity } from "./contracts.ts";
import { ExternalToolSchema } from "./contracts.ts";

export type ResolvedExternalTool = {
  name: string;
  command: string;
  args: string[];
  versionArgs: string[];
  timeoutMs: number;
  missingSeverity: ExternalToolMissingSeverity;
};

const defaultVersionArgs = ["--version"];
const defaultTimeoutMs = 5_000;

export function resolveExternalTool(name: string, tools: Record<string, ExternalTool> = {}): ResolvedExternalTool {
  return normalizeExternalTool(name, tools[name]);
}

export function normalizeExternalTool(name: string, tool: ExternalTool | undefined): ResolvedExternalTool {
  if (tool === undefined) {
    return {
      name,
      command: name,
      args: [],
      versionArgs: [...defaultVersionArgs],
      timeoutMs: defaultTimeoutMs,
      missingSeverity: "error",
    };
  }

  if (typeof tool === "string") {
    return {
      name,
      command: tool,
      args: [],
      versionArgs: [...defaultVersionArgs],
      timeoutMs: defaultTimeoutMs,
      missingSeverity: "error",
    };
  }

  if (Array.isArray(tool)) {
    return {
      name,
      command: tool[0],
      args: tool.slice(1),
      versionArgs: [...defaultVersionArgs],
      timeoutMs: defaultTimeoutMs,
      missingSeverity: "error",
    };
  }

  const commandParts = typeof tool.command === "string" ? [tool.command] : tool.command;
  const missingSeverity = tool.missingSeverity ?? (tool.required === false ? "warning" : "error");
  return {
    name,
    command: commandParts[0],
    args: commandParts.slice(1),
    versionArgs: tool.versionArgs ? [...tool.versionArgs] : [...defaultVersionArgs],
    timeoutMs: tool.timeoutMs ?? defaultTimeoutMs,
    missingSeverity,
  };
}

export function validateExternalTool(name: string, value: unknown): string[] {
  if (!name) return ["externalTools keys must be non-empty."];
  const result = ExternalToolSchema.safeParse(value);
  if (result.success) return [];
  return [`externalTools.${name} must be a command string, string array, or object with command.`];
}
