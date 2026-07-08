import type { ContextPaths } from "./context.ts";
import {
  AreaCheckKind,
  AreaRenderKind,
  AreaRenderStyle,
  type Area,
  type AreaCheck,
} from "./area.ts";
import { definitionTargetRows } from "./definition-target.ts";
import { normalizeMarkdownHeading } from "./docs.ts";
import { resolveInsideRoot } from "./paths.ts";

type AreaSectionKey = "summary" | "ownership" | "stories" | "behaviors" | "checks" | "surfaces" | "dependencies" | "governance";

type ResolvedAreaDocsPath =
  | { ok: true; path: string; absolutePath: string }
  | { ok: false; diagnostics: string[] };

const MarkdownFilePattern = /\.(md|markdown)$/i;
const AreaSectionTitle: Record<AreaSectionKey, string> = {
  summary: "Summary",
  ownership: "Ownership",
  stories: "Stories",
  behaviors: "Behaviors",
  checks: "Checks",
  surfaces: "Impact surfaces",
  dependencies: "Dependencies",
  governance: "Governance",
};
const AreaStyleSections: Record<AreaRenderStyle, AreaSectionKey[]> = {
  narrative: ["summary", "ownership", "stories", "behaviors", "checks", "surfaces", "dependencies", "governance"],
  checklist: ["summary", "checks", "stories", "behaviors", "ownership", "surfaces", "dependencies", "governance"],
  reference: ["summary", "ownership", "surfaces", "checks", "stories", "behaviors", "dependencies", "governance"],
  "architecture-note": ["summary", "ownership", "surfaces", "dependencies", "behaviors", "checks", "stories", "governance"],
  "decision-record": ["summary", "surfaces", "ownership", "dependencies", "checks", "behaviors", "stories", "governance"],
};

export function renderArea(area: Area, style: AreaRenderStyle): string {
  const lines: string[] = [];
  lines.push(`# ${area.title}`);
  lines.push("");
  lines.push(`Area id: \`${area.id}\`.`);

  for (const section of AreaStyleSections[style]) {
    const rendered = renderAreaSection(area, style, section);
    if (rendered.length === 0) continue;
    lines.push("");
    lines.push(`## ${AreaSectionTitle[section]}`);
    lines.push("");
    lines.push(...rendered);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function areaAnchor(area: Pick<Area, "title">): string {
  return normalizeMarkdownHeading(area.title);
}

export function areaDocsReference(area: Area): string | undefined {
  if (area.render.kind === AreaRenderKind.None) return undefined;
  return `${area.render.docs}#${areaAnchor(area)}`;
}

export function resolveAreaGeneratedDocsPath(paths: Pick<ContextPaths, "rootDir">, area: Area): ResolvedAreaDocsPath {
  if (area.render.kind !== AreaRenderKind.Generated) return { ok: false, diagnostics: [`Area ${area.id} is not generated.`] };
  return resolveGeneratedMarkdownPath(paths, `Area ${area.id}`, area.render.docs);
}

export function validateGeneratedAreaDocsPath(owner: string, docsPath: string, context: { paths?: Pick<ContextPaths, "rootDir"> } = {}): string[] {
  const resolved = resolveGeneratedMarkdownPath(context.paths, owner, docsPath);
  return resolved.ok ? [] : resolved.diagnostics;
}

function renderAreaSection(area: Area, style: AreaRenderStyle, section: AreaSectionKey): string[] {
  switch (section) {
    case "summary":
      return renderSummary(area, style);
    case "ownership":
      return renderOwnership(area, style);
    case "stories":
      return renderStories(area, style);
    case "behaviors":
      return renderBehaviors(area, style);
    case "checks":
      return renderChecks(area, style);
    case "surfaces":
      return renderSurfaces(area, style);
    case "dependencies":
      return renderDependencies(area, style);
    case "governance":
      return renderGovernance(area, style);
  }
}

function renderSummary(area: Area, style: AreaRenderStyle): string[] {
  switch (style) {
    case AreaRenderStyle.Narrative:
      return [area.summary];
    case AreaRenderStyle.Checklist:
      return [`- [ ] Confirm area intent: ${area.summary}`];
    case AreaRenderStyle.Reference:
      return [area.summary];
    case AreaRenderStyle.ArchitectureNote:
      return [`Product behavior: ${area.summary}`];
    case AreaRenderStyle.DecisionRecord:
      return [`Decision outcome: ${area.summary}`];
  }
}

function renderOwnership(area: Area, style: AreaRenderStyle): string[] {
  const rows = ownershipRows(area);
  if (rows.length === 0) return [];
  switch (style) {
    case AreaRenderStyle.Narrative:
      return ["The area owns:", ...rows.map(([label, values]) => `- ${label}: ${values.join(", ")}`)];
    case AreaRenderStyle.Checklist:
      return rows.map(([label, values]) => `- [ ] Verify ${label.toLowerCase()}: ${values.join(", ")}`);
    case AreaRenderStyle.Reference:
      return rows.map(([label, values]) => `${label}: ${values.join(", ")}`);
    case AreaRenderStyle.ArchitectureNote:
      return ["Owned product surfaces:", ...rows.map(([label, values]) => `- ${label}: ${values.join(", ")}`)];
    case AreaRenderStyle.DecisionRecord:
      return ["Owned scope for this product decision:", ...rows.map(([label, values]) => `- ${label}: ${values.join(", ")}`)];
  }
}

function renderStories(area: Area, style: AreaRenderStyle): string[] {
  const stories = area.stories ?? [];
  if (stories.length === 0) return [];
  return stories.flatMap((story, index) => [
    ...(index > 0 ? [""] : []),
    style === AreaRenderStyle.Checklist ? `- [ ] Story \`${story.id}\`: as ${story.as}, I want ${story.want}, so ${story.so}.` : `Story \`${story.id}\`: as ${story.as}, I want ${story.want}, so ${story.so}.`,
    ...story.acceptance.map((item) => `${style === AreaRenderStyle.Checklist ? "  - [ ]" : "-"} ${item}`),
    ...(story.checks && story.checks.length > 0 ? [`Checks: ${story.checks.map((check) => checkLink(check)).join(", ")}`] : []),
  ]);
}

function renderBehaviors(area: Area, style: AreaRenderStyle): string[] {
  const behaviors = area.behaviors ?? [];
  if (behaviors.length === 0) return [];
  return behaviors.flatMap((behavior, index) => [
    ...(index > 0 ? [""] : []),
    style === AreaRenderStyle.Checklist
      ? `- [ ] Behavior \`${behavior.id}\`: ${behavior.actor} ${behavior.action}; ${behavior.outcome}.`
      : `Behavior \`${behavior.id}\`: ${behavior.actor} ${behavior.action}; ${behavior.outcome}.`,
    ...(behavior.checks && behavior.checks.length > 0 ? [`Checks: ${behavior.checks.map((check) => checkLink(check)).join(", ")}`] : []),
  ]);
}

function renderChecks(area: Area, style: AreaRenderStyle): string[] {
  const checks = area.checks ?? [];
  if (checks.length === 0) return [];
  return checks.map((check) => (style === AreaRenderStyle.Checklist ? `- [ ] ${checkSummary(check)}` : `- ${checkSummary(check)}`));
}

function renderSurfaces(area: Area, style: AreaRenderStyle): string[] {
  const surfaces = area.surfaces ?? [];
  if (surfaces.length === 0) return [];
  const links = surfaces.map((surface) => impactSurfaceLink(surface));
  switch (style) {
    case AreaRenderStyle.Narrative:
      return ["Linked impact surfaces:", ...links.map((item) => `- ${item}`)];
    case AreaRenderStyle.Checklist:
      return links.map((item) => `- [ ] Review impact surface ${item}`);
    case AreaRenderStyle.Reference:
      return links.map((item) => `- ${item}`);
    case AreaRenderStyle.ArchitectureNote:
      return ["Architecture surfaces touched by this behavior:", ...links.map((item) => `- ${item}`)];
    case AreaRenderStyle.DecisionRecord:
      return ["Impact surfaces considered:", ...links.map((item) => `- ${item}`)];
  }
}

function renderDependencies(area: Area, style: AreaRenderStyle): string[] {
  const dependencies = area.dependsOn ?? [];
  if (dependencies.length === 0) return [];
  return dependencies.map((id) => (style === AreaRenderStyle.Checklist ? `- [ ] Check dependency ${areaLink(id)}` : `- ${areaLink(id)}`));
}

function renderGovernance(area: Area, style: AreaRenderStyle): string[] {
  const governedBy = area.governedBy;
  if (!governedBy) return [];
  const rows = [
    ...(governedBy.inferFromScope ? ["infer governing conventions from owned scope"] : []),
    ...(governedBy.conventions ?? []).map((id) => `convention ${conventionLink(id)}`),
  ];
  if (rows.length === 0) return [];
  return rows.map((row) => (style === AreaRenderStyle.Checklist ? `- [ ] ${row}` : `- ${row}`));
}

function ownershipRows(area: Area): Array<[string, string[]]> {
  return definitionTargetRows(area.owns);
}

function checkSummary(check: AreaCheck): string {
  switch (check.kind) {
    case AreaCheckKind.Command:
      return `${checkLink(check.id)} command \`${check.command}\`${check.description ? `: ${check.description}` : ""}`;
    case AreaCheckKind.Doctor:
      return `${checkLink(check.id)} doctor${check.description ? `: ${check.description}` : ""}`;
    case AreaCheckKind.Validator:
      return `${checkLink(check.id)} validator \`${check.validatorId}\`${check.description ? `: ${check.description}` : ""}`;
    case AreaCheckKind.Test:
      return `${checkLink(check.id)} test \`${check.target}\`${check.description ? `: ${check.description}` : ""}`;
  }
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

function resolveGeneratedMarkdownPath(
  paths: Pick<ContextPaths, "rootDir"> | undefined,
  owner: string,
  docsPath: string,
): ResolvedAreaDocsPath {
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
