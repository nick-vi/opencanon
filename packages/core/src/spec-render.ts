import type { ContextPaths } from "./context.ts";
import {
  SpecCheckKind,
  SpecRenderKind,
  SpecRenderStyle,
  type Spec,
  type SpecCheck,
  type SpecRenderStyle as SpecRenderStyleType,
  type SpecScope,
} from "./spec.ts";
import { definitionTargetRows } from "./definition-target.ts";
import { normalizeMarkdownHeading } from "./docs.ts";
import { resolveInsideRoot } from "./paths.ts";

type SpecSectionKey = "summary" | "scope" | "rules" | "scenarios" | "checks" | "surfaces" | "areas" | "dependencies" | "governance";

type ResolvedSpecDocsPath =
  | { ok: true; path: string; absolutePath: string }
  | { ok: false; diagnostics: string[] };

const MarkdownFilePattern = /\.(md|markdown)$/i;
const SpecSectionTitle: Record<SpecSectionKey, string> = {
  summary: "Summary",
  scope: "Scope",
  rules: "Rules",
  scenarios: "Scenarios",
  checks: "Checks",
  surfaces: "Impact surfaces",
  areas: "Areas",
  dependencies: "Dependencies",
  governance: "Governance",
};
const SpecStyleSections: Record<SpecRenderStyleType, SpecSectionKey[]> = {
  narrative: ["summary", "scope", "rules", "scenarios", "checks", "surfaces", "areas", "dependencies", "governance"],
  checklist: ["summary", "checks", "rules", "scenarios", "scope", "surfaces", "areas", "dependencies", "governance"],
  reference: ["summary", "scope", "surfaces", "areas", "checks", "rules", "scenarios", "dependencies", "governance"],
  "architecture-note": ["summary", "scope", "surfaces", "dependencies", "rules", "checks", "scenarios", "areas", "governance"],
  "decision-record": ["summary", "surfaces", "scope", "dependencies", "checks", "rules", "scenarios", "areas", "governance"],
};

export function renderSpec(spec: Spec, style: SpecRenderStyleType): string {
  const lines: string[] = [];
  lines.push(`# ${spec.title}`);
  lines.push("");
  lines.push(`Spec id: \`${spec.id}\`.`);

  for (const section of SpecStyleSections[style]) {
    const rendered = renderSpecSection(spec, style, section);
    if (rendered.length === 0) continue;
    lines.push("");
    lines.push(`## ${SpecSectionTitle[section]}`);
    lines.push("");
    lines.push(...rendered);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function specAnchor(spec: Pick<Spec, "title">): string {
  return normalizeMarkdownHeading(spec.title);
}

export function specDocsReference(spec: Spec): string | undefined {
  if (spec.render.kind === SpecRenderKind.None) return undefined;
  return `${spec.render.docs}#${specAnchor(spec)}`;
}

export function resolveSpecGeneratedDocsPath(paths: Pick<ContextPaths, "rootDir">, spec: Spec): ResolvedSpecDocsPath {
  if (spec.render.kind !== SpecRenderKind.Generated) return { ok: false, diagnostics: [`Spec ${spec.id} is not generated.`] };
  return resolveGeneratedMarkdownPath(paths, `Spec ${spec.id}`, spec.render.docs);
}

export function validateGeneratedSpecDocsPath(owner: string, docsPath: string, context: { paths?: Pick<ContextPaths, "rootDir"> } = {}): string[] {
  const resolved = resolveGeneratedMarkdownPath(context.paths, owner, docsPath);
  return resolved.ok ? [] : resolved.diagnostics;
}

function renderSpecSection(spec: Spec, style: SpecRenderStyleType, section: SpecSectionKey): string[] {
  switch (section) {
    case "summary":
      return renderSummary(spec, style);
    case "scope":
      return renderScope(spec.scope, style);
    case "rules":
      return renderRules(spec, style);
    case "scenarios":
      return renderScenarios(spec, style);
    case "checks":
      return renderChecks(spec, style);
    case "surfaces":
      return renderSurfaces(spec, style);
    case "areas":
      return renderAreas(spec, style);
    case "dependencies":
      return renderDependencies(spec, style);
    case "governance":
      return renderGovernance(spec, style);
  }
}

function renderSummary(spec: Spec, style: SpecRenderStyleType): string[] {
  switch (style) {
    case SpecRenderStyle.Narrative:
      return [spec.summary];
    case SpecRenderStyle.Checklist:
      return [`- [ ] Confirm spec intent: ${spec.summary}`];
    case SpecRenderStyle.Reference:
      return [spec.summary];
    case SpecRenderStyle.ArchitectureNote:
      return [`Business behavior: ${spec.summary}`];
    case SpecRenderStyle.DecisionRecord:
      return [`Decision outcome: ${spec.summary}`];
  }
}

function renderScope(scope: SpecScope | undefined, style: SpecRenderStyleType): string[] {
  const rows = definitionTargetRows(scope);
  if (rows.length === 0) return [];
  return rows.flatMap(([label, values]) => values.map((value) => renderPlainRow(style, label, value)));
}

function renderRules(spec: Spec, style: SpecRenderStyleType): string[] {
  const rules = spec.rules ?? [];
  if (rules.length === 0) return [];
  return rules.flatMap((rule, index) => [
    ...(index > 0 ? [""] : []),
    style === SpecRenderStyle.Checklist ? `- [ ] Rule \`${rule.id}\`: ${rule.statement}` : `Rule \`${rule.id}\`: ${rule.statement}`,
    ...(rule.acceptance ?? []).map((item) => `${style === SpecRenderStyle.Checklist ? "  - [ ]" : "-"} ${item}`),
    ...(rule.checks && rule.checks.length > 0 ? [`Checks: ${rule.checks.map((check) => checkLink(check)).join(", ")}`] : []),
  ]);
}

function renderScenarios(spec: Spec, style: SpecRenderStyleType): string[] {
  const scenarios = spec.scenarios ?? [];
  if (scenarios.length === 0) return [];
  return scenarios.flatMap((scenario, index) => [
    ...(index > 0 ? [""] : []),
    style === SpecRenderStyle.Checklist ? `- [ ] Scenario \`${scenario.id}\`` : `Scenario \`${scenario.id}\``,
    ...scenario.given.map((item) => `${style === SpecRenderStyle.Checklist ? "  - [ ]" : "-"} Given ${item}`),
    `${style === SpecRenderStyle.Checklist ? "  - [ ]" : "-"} When ${scenario.when}`,
    ...scenario.then.map((item) => `${style === SpecRenderStyle.Checklist ? "  - [ ]" : "-"} Then ${item}`),
    ...(scenario.checks && scenario.checks.length > 0 ? [`Checks: ${scenario.checks.map((check) => checkLink(check)).join(", ")}`] : []),
  ]);
}

function renderChecks(spec: Spec, style: SpecRenderStyleType): string[] {
  const checks = spec.checks ?? [];
  if (checks.length === 0) return [];
  return checks.map((check) => (style === SpecRenderStyle.Checklist ? `- [ ] ${checkSummary(check)}` : `- ${checkSummary(check)}`));
}

function renderSurfaces(spec: Spec, style: SpecRenderStyleType): string[] {
  const surfaces = spec.surfaces ?? [];
  if (surfaces.length === 0) return [];
  const links = surfaces.map((surface) => impactSurfaceLink(surface));
  return links.map((item) => (style === SpecRenderStyle.Checklist ? `- [ ] Review impact surface ${item}` : `- ${item}`));
}

function renderAreas(spec: Spec, style: SpecRenderStyleType): string[] {
  const areas = spec.areas ?? [];
  if (areas.length === 0) return [];
  return areas.map((id) => (style === SpecRenderStyle.Checklist ? `- [ ] Review area ${areaLink(id)}` : `- ${areaLink(id)}`));
}

function renderDependencies(spec: Spec, style: SpecRenderStyleType): string[] {
  const dependencies = spec.dependsOn ?? [];
  if (dependencies.length === 0) return [];
  return dependencies.map((id) => (style === SpecRenderStyle.Checklist ? `- [ ] Check dependency ${specLink(id)}` : `- ${specLink(id)}`));
}

function renderGovernance(spec: Spec, style: SpecRenderStyleType): string[] {
  const governedBy = spec.governedBy;
  if (!governedBy) return [];
  const rows = [
    ...(governedBy.inferFromScope ? ["infer governing conventions from spec scope"] : []),
    ...(governedBy.conventions ?? []).map((id) => `convention ${conventionLink(id)}`),
  ];
  if (rows.length === 0) return [];
  return rows.map((row) => (style === SpecRenderStyle.Checklist ? `- [ ] ${row}` : `- ${row}`));
}

function checkSummary(check: SpecCheck): string {
  switch (check.kind) {
    case SpecCheckKind.Command:
      return `${checkLink(check.id)} command \`${check.command}\`${check.description ? `: ${check.description}` : ""}`;
    case SpecCheckKind.Doctor:
      return `${checkLink(check.id)} doctor${check.description ? `: ${check.description}` : ""}`;
    case SpecCheckKind.Validator:
      return `${checkLink(check.id)} validator \`${check.validatorId}\`${check.description ? `: ${check.description}` : ""}`;
    case SpecCheckKind.Test:
      return `${checkLink(check.id)} test \`${check.target}\`${check.description ? `: ${check.description}` : ""}`;
  }
}

function renderPlainRow(style: SpecRenderStyleType, label: string, value: string): string {
  if (style === SpecRenderStyle.Checklist) return `- [ ] Review ${label.toLowerCase()}: \`${value}\``;
  return `- ${label}: \`${value}\``;
}

function checkLink(id: string): string {
  return `\`${id}\``;
}

function areaLink(id: string): string {
  return `[${id}](opencanon://areas/${encodeURIComponent(id)})`;
}

function conventionLink(id: string): string {
  return `[${id}](opencanon://conventions/${encodeURIComponent(id)})`;
}

function impactSurfaceLink(id: string): string {
  return `[${id}](opencanon://impact-surfaces/${encodeURIComponent(id)})`;
}

function specLink(id: string): string {
  return `[${id}](opencanon://specs/${encodeURIComponent(id)})`;
}

function resolveGeneratedMarkdownPath(
  paths: Pick<ContextPaths, "rootDir"> | undefined,
  owner: string,
  docsPath: string,
): ResolvedSpecDocsPath {
  const diagnostics: string[] = [];
  if (docsPath.includes("#")) diagnostics.push(`${owner} generated docs path must not include #<heading-slug>: ${docsPath}`);
  if (!MarkdownFilePattern.test(docsPath.split("#", 1)[0] ?? "")) diagnostics.push(`${owner} generated docs path must point at a Markdown file: ${docsPath}`);
  if (!paths) return diagnostics.length === 0 ? { ok: true, path: docsPath, absolutePath: docsPath } : { ok: false, diagnostics };

  const resolved = resolveInsideRoot(paths.rootDir, docsPath);
  if (!resolved.ok) {
    diagnostics.push(`${owner} generated docs path must stay inside the project: ${docsPath}`);
    return { ok: false, diagnostics };
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, path: resolved.path, absolutePath: resolved.absolutePath };
}
