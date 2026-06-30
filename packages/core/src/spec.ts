import type { AreaId } from "./area.ts";
import type { ConventionId } from "./convention.ts";
import type { DefinitionTarget } from "./definition-target.ts";

export type SpecId = string;

export const SpecRenderKind = {
  Generated: "generated",
  None: "none",
} as const;
export type SpecRenderKind = (typeof SpecRenderKind)[keyof typeof SpecRenderKind];

export const SpecRenderStyle = {
  Narrative: "narrative",
  Checklist: "checklist",
  Reference: "reference",
  ArchitectureNote: "architecture-note",
  DecisionRecord: "decision-record",
} as const;
export type SpecRenderStyle = (typeof SpecRenderStyle)[keyof typeof SpecRenderStyle];

export const SpecCheckKind = {
  Command: "command",
  Doctor: "doctor",
  Validator: "validator",
  Test: "test",
} as const;
export type SpecCheckKind = (typeof SpecCheckKind)[keyof typeof SpecCheckKind];

export type SpecRender =
  | { kind: "generated"; docs: string; style: SpecRenderStyle }
  | { kind: "none" };

export type SpecScope = DefinitionTarget[];

export type SpecCheck =
  | { id: string; kind: "command"; command: string; description?: string }
  | { id: string; kind: "doctor"; description?: string }
  | { id: string; kind: "validator"; validatorId: string; description?: string }
  | { id: string; kind: "test"; target: string; description?: string };

export type SpecRule = {
  id: string;
  statement: string;
  acceptance?: string[];
  checks?: string[];
};

export type SpecScenario = {
  id: string;
  given: string[];
  when: string;
  then: string[];
  checks?: string[];
};

export type SpecGovernance = {
  inferFromScope?: boolean;
  conventions?: ConventionId[];
};

export type Spec = {
  id: SpecId;
  title: string;
  summary: string;
  scope?: SpecScope;
  surfaces?: string[];
  areas?: AreaId[];
  rules?: SpecRule[];
  scenarios?: SpecScenario[];
  checks?: SpecCheck[];
  dependsOn?: SpecId[];
  governedBy?: SpecGovernance;
  render: SpecRender;
};

export type SpecResolution = {
  byId: Map<SpecId, Spec>;
  diagnostics: string[];
};

export function defineSpec(spec: Spec): Spec {
  return spec;
}

export function resolveSpecs(specs: Spec[]): SpecResolution {
  const diagnostics: string[] = [];
  const byId = new Map<SpecId, Spec>();

  for (const spec of specs) {
    if (byId.has(spec.id)) {
      diagnostics.push(`Duplicate spec id: ${spec.id}.`);
      continue;
    }
    byId.set(spec.id, spec);
  }

  return { byId, diagnostics };
}
