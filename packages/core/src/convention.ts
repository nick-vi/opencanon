import type { FactKind, ValidatorScope } from "./contracts.ts";
import { conventionDocsReference } from "./convention-render.ts";
import { ValidatorDomain } from "./validator-types.ts";
import type { Finding, Severity, ValidatorArgs, ValidatorDefinition, ValidatorVisual } from "./validator-types.ts";

/**
 * Unified Convention model — one umbrella concept for docs, runtime checks, gates,
 * generated context, and history.
 *
 * A Convention is composed from THREE independent discriminated axes — `applies`, `render`,
 * `runtime` — never a single god-`kind`. Illegal combinations are unrepresentable: a
 * docs-only convention's type has no `validate`; a `none`-render convention has no `docs`.
 *
 * Invariants (locked):
 *  - No proposed/active status — committing the definition is ratification.
 *  - Definition docs are either deterministic render(definition) artifacts or absent.
 *  - Generated Markdown is never hand-edited; doctor re-renders and diffs it.
 *  - `id` is the stable machine identity AND the cross-reference key (never the title).
 */

/** Stable kebab id; also the cross-reference + approval key. */
export type ConventionId = string;

export const ConventionAppliesKind = {
  Files: "files",
  Symbols: "symbols",
  Imports: "imports",
  ImpactSurface: "impact-surface",
  Definitions: "definitions",
  Project: "project",
  Custom: "custom",
} as const;

export const ConventionDefinitionKind = {
  Area: "area",
  Change: "change",
  Convention: "convention",
  Spec: "spec",
} as const;
export type ConventionDefinitionKind = (typeof ConventionDefinitionKind)[keyof typeof ConventionDefinitionKind];

/** AXIS 1 — where the convention is in scope. Structured for the engine, rendered to prose. */
export type Applies =
  | { kind: "files"; globs: string[] }
  | { kind: "symbols"; globs: string[]; symbolKinds?: ("function" | "class" | "type")[] }
  | { kind: "imports"; from?: string[]; to?: string[] }
  | { kind: "impact-surface"; surfaceIds: string[] }
  | { kind: "definitions"; definitions: Array<{ kind: ConventionDefinitionKind; ids?: string[] }> }
  | { kind: "project"; describe?: string }
  | { kind: "custom"; describe: string };

export const ConventionRenderStyle = {
  Narrative: "narrative",
  Checklist: "checklist",
  Reference: "reference",
  ArchitectureNote: "architecture-note",
  DecisionRecord: "decision-record",
} as const;

/** Markdown render styles. Each style is rendered deterministically from the convention. */
export type RenderStyle = (typeof ConventionRenderStyle)[keyof typeof ConventionRenderStyle];

export const ConventionRenderKind = {
  Generated: "generated",
  None: "none",
} as const;

/** AXIS 2 — how (and whether) docs are produced.
 *  - `generated`: OpenCanon owns `docs`; it equals render(definition); doctor re-renders+diffs.
 *  - `none`:      no doc (e.g. a pure-test convention). */
export type Render =
  | { kind: "generated"; docs: string; style: RenderStyle }
  | { kind: "none" };

/** The executable core of an enforcing convention (no severity — gate implies blocking). */
export type RuntimeBody = {
  scope: ValidatorScope;
  /** Explicit validation domain. Defaults from `applies`; use it to name globless definition/project checks. */
  domain?: ValidatorDefinition["domain"];
  facts: FactKind[];
  visuals?: ValidatorVisual[];
  requiresProducers?: string[];
  fixtures?: "valid-and-invalid" | "valid-only";
  validate(args: ValidatorArgs): Finding[] | Promise<Finding[]>;
};

export const ConventionRuntimeKind = {
  None: "none",
  Validator: "validator",
  Gate: "gate",
  Test: "test",
} as const;

/** AXIS 3 — whether/how the convention is enforced.
 *  - `none`:      advisory docs only.
 *  - `validator`: produces findings (severity-controlled; non-blocking warnings by default).
 *  - `gate`:      blocks commit until the user resolves the asked question (always error-level).
 *  - `test`:      validator-only canon with no docs. */
export type Runtime =
  | { kind: "none" }
  | ({ kind: "validator"; severity: Severity } & RuntimeBody)
  | ({ kind: "gate"; question: string } & RuntimeBody)
  | ({ kind: "test"; severity: Severity } & RuntimeBody);

/** Common identity + content, present on EVERY convention (so validator-only ones are still
 *  legible in gates + history), plus the three composed axes. */
export type Convention = {
  id: ConventionId;
  title: string;
  topics?: string[];
  why?: string;
  rule: string;
  examples?: { good?: string; bad?: string; note?: string }[];
  related?: ConventionId[];
  impactSurfaces?: string[];
  applies: Applies;
  render: Render;
  runtime: Runtime;
};

/** Authoring helper that preserves the literal convention shape for TypeScript inference. */
export function defineConvention(convention: Convention): Convention {
  return convention;
}

export type ConventionResolution = {
  /** Effective conventions by id, after local dedupe. */
  byId: Map<ConventionId, Convention>;
  diagnostics: string[];
};

/**
 * Resolve local conventions into the effective set.
 * A duplicate id is an error because committed definition authorship must be unambiguous.
 * Approval records, commit gates, docs backlinks, and history helpers depend on these stable lookup semantics.
 */
export function resolveConventions(local: Convention[]): ConventionResolution {
  const diagnostics: string[] = [];
  const byId = new Map<ConventionId, Convention>();

  const seenLocal = new Set<ConventionId>();
  for (const convention of local) {
    if (seenLocal.has(convention.id)) {
      diagnostics.push(`Duplicate local convention id: ${convention.id}.`);
      continue;
    }
    seenLocal.add(convention.id);
    byId.set(convention.id, convention);
  }

  return { byId, diagnostics };
}

/** Resolve a reference to the effective convention by current id only. */
export function lookupConvention(resolution: ConventionResolution, ref: ConventionId): Convention | undefined {
  return resolution.byId.get(ref);
}

/** Flatten the structured `applies` axis to the glob scopes the executor matches `targetFiles`
 *  against. Non-glob applies (imports/impact-surface/custom) carry their detail in the
 *  validate body or are resolved at runtime; the glob list bounds where the rule is evaluated. */
function appliesToGlobs(applies: Applies): string[] {
  switch (applies.kind) {
    case "files":
    case "symbols":
      return applies.globs;
    case "imports":
      return applies.from ?? [];
    case "impact-surface":
    case "definitions":
    case "project":
    case "custom":
      return []; // explicit non-glob domains; validators inspect runtime definitions/project state.
  }
}

function appliesToValidatorDomain(applies: Applies): ValidatorDefinition["domain"] {
  switch (applies.kind) {
    case "files":
    case "symbols":
      return ValidatorDomain.File;
    case "imports":
      return ValidatorDomain.ImportEdge;
    case "impact-surface":
      return ValidatorDomain.ImpactSurface;
    case "definitions":
      return ValidatorDomain.Definition;
    case "project":
      return ValidatorDomain.Project;
    case "custom":
      return ValidatorDomain.Custom;
  }
}

/**
 * Adapt a Convention to the executor's ValidatorDefinition — the single bridge from the
 * authoring model to the validator runtime. Returns undefined for non-enforcing conventions
 * (`runtime.kind === "none"`): docs-only conventions never execute.
 *
 * A `gate` convention's findings are produced by its own validate body (which calls
 * `ctx.commitGate(...)`); the adapter just routes its scope/facts/validate through.
 */
export function conventionToValidator(convention: Convention): ValidatorDefinition | undefined {
  if (convention.runtime.kind === ConventionRuntimeKind.None) return undefined;
  const { runtime } = convention;
  return {
    id: convention.id,
    topics: convention.topics ?? [],
    applies: appliesToGlobs(convention.applies),
    domain: runtime.domain ?? appliesToValidatorDomain(convention.applies),
    severity: runtime.kind === ConventionRuntimeKind.Gate ? "error" : runtime.severity,
    scope: runtime.scope,
    facts: runtime.facts,
    conventionIds: [convention.id, ...(convention.related ?? [])],
    docs: convention.render.kind === ConventionRenderKind.None ? undefined : [conventionDocsReference(convention)!],
    summary: convention.rule,
    visuals: runtime.visuals,
    requiresProducers: runtime.requiresProducers,
    fixtures: runtime.fixtures,
    validate: runtime.validate,
  };
}
