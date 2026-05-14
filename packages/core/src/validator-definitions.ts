import type { FactKind, ValidatorScope } from "./contracts.ts";
import { factKindValues, validatorScopeValues } from "./contracts.ts";
import { matchesAny, unique } from "./core.ts";
import type { Severity, Validator, ValidatorDefinition, ValidatorSummary, ValidatorSummaryInput, ValidatorVisual } from "./validator-types.ts";

const FactKeySeparator = "\u0000";

export function validateValidatorDefinitions(definition: unknown): string[] {
  return resolveValidators(definition).diagnostics;
}

export function resolveValidators(input: unknown): { validators: Validator[]; diagnostics: string[] } {
  const definitions = Array.isArray(input) ? input : [input];
  const validators: Validator[] = [];
  const diagnostics: string[] = [];
  const ids = new Set<string>();

  for (const definition of definitions) {
    traverseValidatorDefinition({
      definition,
      inherited: {
        topics: [],
        decisionIds: [],
        severity: undefined,
        scope: undefined,
        facts: [],
        appliesScopes: [],
        docs: [],
      },
      validators,
      diagnostics,
      ids,
    });
  }

  return { validators, diagnostics };
}

export function validatorMatchesFile(validator: Validator, file: string): boolean {
  return validator.appliesScopes.length === 0 || validator.appliesScopes.every((patterns) => matchesAny(file, patterns));
}

export function validatorMatchesAnyFile(validator: Validator, files: string[]): boolean {
  return files.some((file) => validatorMatchesFile(validator, file));
}

export function formatValidatorApplies(validator: Validator): string[] {
  return formatAppliesScopes(validator.appliesScopes);
}

type InheritedValidatorMetadata = {
  topics: string[];
  decisionIds: string[];
  severity: Severity | undefined;
  scope: ValidatorScope | undefined;
  facts: FactKind[];
  appliesScopes: string[][];
  docs: string[];
};

function traverseValidatorDefinition(params: {
  definition: unknown;
  inherited: InheritedValidatorMetadata;
  validators: Validator[];
  diagnostics: string[];
  ids: Set<string>;
}): void {
  const { definition, inherited, validators, diagnostics, ids } = params;
  const value = definition as Partial<ValidatorDefinition>;
  const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  const validSeverities = new Set(["error", "warning"]);
  const validScopes = new Set<ValidatorScope>(validatorScopeValues);
  const validFacts = new Set<FactKind>(factKindValues);

  if (!value || typeof value !== "object") {
    diagnostics.push("Validator definition must be an object.");
    return;
  }

  const id = typeof value.id === "string" ? value.id : "<unknown>";
  const childDefinitions = Array.isArray(value.validators) ? value.validators : [];
  for (const key of Object.keys(value)) {
    if (!["id", "topics", "applies", "severity", "scope", "facts", "decisionIds", "docs", "summary", "visuals", "validate", "validators"].includes(key)) {
      diagnostics.push(`Validator ${id} has unknown key: ${key}.`);
    }
  }
  if (typeof value.id !== "string" || !idPattern.test(value.id)) diagnostics.push(`Validator ${id} id must be kebab-case.`);
  if (typeof value.id === "string") {
    if (ids.has(value.id)) diagnostics.push(`Duplicate validator id: ${value.id}`);
    ids.add(value.id);
  }
  if (value.topics !== undefined && (!Array.isArray(value.topics) || value.topics.some((topic) => typeof topic !== "string" || topic.length === 0))) {
    diagnostics.push(`Validator ${id} topics must be non-empty strings when present.`);
  }
  if (value.applies !== undefined && (!Array.isArray(value.applies) || value.applies.some((item) => typeof item !== "string" || item.length === 0))) {
    diagnostics.push(`Validator ${id} applies must be string[] when present.`);
  }
  if (value.severity !== undefined && !validSeverities.has(value.severity as Severity)) diagnostics.push(`Validator ${id} severity must be error or warning.`);
  if (value.scope !== undefined && !validScopes.has(value.scope as ValidatorScope)) {
    diagnostics.push(`Validator ${id} scope must be one of: ${validatorScopeValues.join(", ")}.`);
  }
  if (value.facts !== undefined && (!Array.isArray(value.facts) || value.facts.some((item) => !validFacts.has(item as FactKind)))) {
    diagnostics.push(`Validator ${id} facts must be known fact kinds: ${factKindValues.join(", ")}.`);
  }
  if (value.decisionIds !== undefined && (!Array.isArray(value.decisionIds) || value.decisionIds.some((item) => typeof item !== "string" || item.length === 0))) {
    diagnostics.push(`Validator ${id} decisionIds must be string[] when present.`);
  }
  if (value.docs !== undefined && (!Array.isArray(value.docs) || value.docs.some((item) => typeof item !== "string" || item.length === 0))) {
    diagnostics.push(`Validator ${id} docs must be string[] when present.`);
  }
  if (value.summary !== undefined && typeof value.summary !== "string" && typeof value.summary !== "function") {
    diagnostics.push(`Validator ${id} summary must be a string or function when present.`);
  }
  if (value.visuals !== undefined) diagnostics.push(...validateValidatorVisuals(id, value.visuals));
  if (value.validate !== undefined && typeof value.validate !== "function") diagnostics.push(`Validator ${id} validate must be a function when present.`);
  if (value.validators !== undefined && !Array.isArray(value.validators)) diagnostics.push(`Validator ${id} validators must be an array when present.`);
  if (!value.validate && childDefinitions.length === 0) diagnostics.push(`Validator ${id} needs validate() or validators[].`);

  const next: InheritedValidatorMetadata = {
    topics: unique([...inherited.topics, ...(value.topics ?? [])]),
    decisionIds: unique([...inherited.decisionIds, ...(value.decisionIds ?? [])]),
    severity: (value.severity as Severity | undefined) ?? inherited.severity,
    scope: (value.scope as ValidatorScope | undefined) ?? inherited.scope,
    facts: unique([...inherited.facts, ...((value.facts as FactKind[] | undefined) ?? [])]),
    appliesScopes: value.applies ? appendAppliesScope(inherited.appliesScopes, value.applies) : inherited.appliesScopes,
    docs: unique([...inherited.docs, ...(value.docs ?? [])]),
  };

  if (value.validate && typeof value.id === "string") {
    if (next.topics.length === 0) diagnostics.push(`Validator ${value.id} needs at least one topic from itself or a parent.`);
    if (!next.severity) diagnostics.push(`Validator ${value.id} needs severity from itself or a parent.`);
    if (!next.scope) diagnostics.push(`Validator ${value.id} needs scope from itself or a parent.`);
    const summary = resolveSummary(
      typeof value.summary === "string" || typeof value.summary === "function" ? value.summary : undefined,
      {
        id: value.id,
        topics: next.topics,
        applies: formatAppliesScopes(next.appliesScopes),
        severity: next.severity ?? "error",
        scope: next.scope ?? "project",
        facts: next.facts,
        decisionIds: next.decisionIds,
        docs: next.docs,
      },
      diagnostics,
    );

    validators.push({
      id: value.id,
      topics: next.topics,
      appliesScopes: next.appliesScopes,
      severity: next.severity ?? "error",
      scope: next.scope ?? "project",
      facts: next.facts,
      decisionIds: next.decisionIds,
      docs: next.docs,
      summary,
      visuals: value.visuals ?? [],
      validate: value.validate,
    });
  }

  for (const child of childDefinitions) {
    traverseValidatorDefinition({
      definition: child,
      inherited: next,
      validators,
      diagnostics,
      ids,
    });
  }
}

function validateValidatorVisuals(id: string, value: unknown): string[] {
  const diagnostics: string[] = [];
  if (!Array.isArray(value)) return [`Validator ${id} visuals must be an array when present.`];
  for (const [index, visual] of value.entries()) {
    const label = `Validator ${id} visual ${index + 1}`;
    if (!visual || typeof visual !== "object" || Array.isArray(visual)) {
      diagnostics.push(`${label} must be an object.`);
      continue;
    }
    const record = visual as Partial<ValidatorVisual>;
    for (const key of Object.keys(record)) {
      if (!["kind", "title", "definition"].includes(key)) diagnostics.push(`${label} has unknown key: ${key}.`);
    }
    if (record.kind !== "tree") diagnostics.push(`${label} kind must be tree.`);
    if (record.title !== undefined && typeof record.title !== "string") diagnostics.push(`${label} title must be a string when present.`);
    if (record.definition === undefined) diagnostics.push(`${label} definition is required.`);
  }
  return diagnostics;
}

function resolveSummary(summary: ValidatorSummary | undefined, input: ValidatorSummaryInput, diagnostics: string[]): string | undefined {
  if (summary === undefined) return undefined;
  if (typeof summary === "string") return summary;

  try {
    const resolved = summary(input);
    if (typeof resolved !== "string") {
      diagnostics.push(`Validator ${input.id} summary function must return a string.`);
      return undefined;
    }
    return resolved;
  } catch (error) {
    diagnostics.push(`Validator ${input.id} summary function failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function formatAppliesScopes(scopes: string[][]): string[] {
  if (scopes.length === 0) return ["<project>"];
  if (scopes.length === 1) return scopes[0];
  return [scopes.map((patterns) => patterns.join(", ")).join(" && ")];
}

function appendAppliesScope(scopes: string[][], patterns: string[]): string[][] {
  const key = patterns.join(FactKeySeparator);
  if (scopes.some((scope) => scope.join(FactKeySeparator) === key)) return scopes;
  return [...scopes, patterns];
}


