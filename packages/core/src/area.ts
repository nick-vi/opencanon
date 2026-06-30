import type { DefinitionTarget } from "./definition-target.ts";

export type AreaId = string;

export const AreaRenderKind = {
  Generated: "generated",
  None: "none",
} as const;
export type AreaRenderKind = (typeof AreaRenderKind)[keyof typeof AreaRenderKind];

export const AreaRenderStyle = {
  Narrative: "narrative",
  Checklist: "checklist",
  Reference: "reference",
  ArchitectureNote: "architecture-note",
  DecisionRecord: "decision-record",
} as const;
export type AreaRenderStyle = (typeof AreaRenderStyle)[keyof typeof AreaRenderStyle];

export const AreaCheckKind = {
  Command: "command",
  Doctor: "doctor",
  Validator: "validator",
  Test: "test",
} as const;
export type AreaCheckKind = (typeof AreaCheckKind)[keyof typeof AreaCheckKind];

export type AreaRender =
  | { kind: "generated"; docs: string; style: AreaRenderStyle }
  | { kind: "none" };

export type AreaOwnership = DefinitionTarget[];

export type AreaCheck =
  | { id: string; kind: "command"; command: string; description?: string }
  | { id: string; kind: "doctor"; description?: string }
  | { id: string; kind: "validator"; validatorId: string; description?: string }
  | { id: string; kind: "test"; target: string; description?: string };

export type AreaStory = {
  id: string;
  as: string;
  want: string;
  so: string;
  acceptance: string[];
  checks?: string[];
};

export type AreaBehavior = {
  id: string;
  actor: string;
  action: string;
  outcome: string;
  checks?: string[];
};

export type AreaGovernance = {
  inferFromScope?: boolean;
  conventions?: string[];
};

export type Area = {
  id: AreaId;
  title: string;
  summary: string;
  surfaces?: string[];
  owns?: AreaOwnership;
  stories?: AreaStory[];
  behaviors?: AreaBehavior[];
  checks?: AreaCheck[];
  dependsOn?: AreaId[];
  governedBy?: AreaGovernance;
  render: AreaRender;
};

export type AreaResolution = {
  byId: Map<AreaId, Area>;
  diagnostics: string[];
};

export function defineArea(area: Area): Area {
  return area;
}

export function resolveAreas(areas: Area[]): AreaResolution {
  const diagnostics: string[] = [];
  const byId = new Map<AreaId, Area>();

  for (const area of areas) {
    if (byId.has(area.id)) {
      diagnostics.push(`Duplicate area id: ${area.id}.`);
      continue;
    }
    byId.set(area.id, area);
  }

  return { byId, diagnostics };
}
