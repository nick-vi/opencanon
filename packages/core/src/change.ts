import type { AreaId } from "./area.ts";
import type { ConventionId } from "./convention.ts";
import type { DefinitionTarget } from "./definition-target.ts";
import type { SpecId } from "./spec.ts";

export type ChangeId = string;

export const ChangeKind = {
  Feature: "feature",
  Fix: "fix",
  Refactor: "refactor",
  Docs: "docs",
  Chore: "chore",
  Research: "research",
} as const;
export type ChangeKind = (typeof ChangeKind)[keyof typeof ChangeKind];

export const ChangeRenderKind = {
  Generated: "generated",
  None: "none",
} as const;
export type ChangeRenderKind = (typeof ChangeRenderKind)[keyof typeof ChangeRenderKind];

export const ChangeRenderStyle = {
  Narrative: "narrative",
  Checklist: "checklist",
  Reference: "reference",
  ArchitectureNote: "architecture-note",
  DecisionRecord: "decision-record",
} as const;
export type ChangeRenderStyle = (typeof ChangeRenderStyle)[keyof typeof ChangeRenderStyle];

export const ChangeCheckKind = {
  Command: "command",
  Doctor: "doctor",
  Validator: "validator",
  Test: "test",
} as const;
export type ChangeCheckKind = (typeof ChangeCheckKind)[keyof typeof ChangeCheckKind];

export const ChangeCheckTimeout = {
  DefaultMs: 2 * 60 * 1000,
  MinimumMs: 100,
  MaximumMs: 30 * 60 * 1000,
} as const;

export type ChangeRender =
  | { kind: "generated"; docs: string; style: ChangeRenderStyle }
  | { kind: "none" };

export type ChangeUpdates = {
  areas?: AreaId[];
  specs?: SpecId[];
  conventions?: ConventionId[];
  surfaces?: string[];
  docs?: string[];
};

export type ChangeScope = DefinitionTarget[];

export type ChangeIntent = {
  problem: string;
  outcome: string;
  why?: string;
};

export type ChangeCheck =
  | { id: string; kind: "command"; command: string; description?: string; timeoutMs?: number }
  | { id: string; kind: "doctor"; description?: string }
  | { id: string; kind: "validator"; validatorId: string; description?: string }
  | { id: string; kind: "test"; target: string; description?: string; timeoutMs?: number };

export function resolveChangeCheckTimeoutMs(check: Extract<ChangeCheck, { kind: "command" | "test" }>): number {
  const timeoutMs = check.timeoutMs ?? ChangeCheckTimeout.DefaultMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < ChangeCheckTimeout.MinimumMs || timeoutMs > ChangeCheckTimeout.MaximumMs) {
    throw new Error(
      `Change check ${check.id} timeoutMs must be an integer from ${ChangeCheckTimeout.MinimumMs} to ${ChangeCheckTimeout.MaximumMs}.`,
    );
  }
  return timeoutMs;
}

export type ChangePlanItem = {
  id: string;
  title: string;
  detail?: string;
  checks?: string[];
};

export type ChangeTask = {
  id: string;
  title: string;
  detail?: string;
  files?: string[];
  surfaces?: string[];
  checks?: string[];
  dependsOn?: string[];
  blockedBy?: string[];
  updates?: ChangeUpdates;
};

export type ChangeLinks = {
  commits?: string[];
  pullRequests?: string[];
  issues?: string[];
};

export type Change = {
  id: ChangeId;
  title: string;
  kind: ChangeKind;
  summary?: string;
  updates?: ChangeUpdates;
  scope?: ChangeScope;
  intent: ChangeIntent;
  plan?: ChangePlanItem[];
  tasks?: ChangeTask[];
  checks?: ChangeCheck[];
  dependsOn?: ChangeId[];
  blockedBy?: ChangeId[];
  links?: ChangeLinks;
  render: ChangeRender;
};

export type ChangeResolution = {
  byId: Map<ChangeId, Change>;
  diagnostics: string[];
};

export function defineChange(change: Change): Change {
  return change;
}

export function resolveChanges(changes: Change[]): ChangeResolution {
  const diagnostics: string[] = [];
  const byId = new Map<ChangeId, Change>();

  for (const change of changes) {
    if (byId.has(change.id)) {
      diagnostics.push(`Duplicate change id: ${change.id}.`);
      continue;
    }
    byId.set(change.id, change);
  }

  return { byId, diagnostics };
}
