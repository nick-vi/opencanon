import type { ContextPaths } from "./context.ts";
import {
  ChangeCheckKind,
  ChangeRenderKind,
  ChangeRenderStyle,
  type Change,
  type ChangeCheck,
  type ChangeRenderStyle as ChangeRenderStyleType,
  type ChangeScope,
  type ChangeUpdates,
} from "./change.ts";
import { definitionTargetRows } from "./definition-target.ts";
import { normalizeMarkdownHeading } from "./docs.ts";
import { resolveInsideRoot } from "./paths.ts";
import {
  renderAreaMarkdownLink,
  renderChangeMarkdownLink,
  renderConventionMarkdownLink,
  renderDocsMarkdownLink,
  renderImpactSurfaceMarkdownLink,
  renderLinkContextForDocs,
  renderSpecMarkdownLink,
  type RenderLinkContext,
} from "./render-links.ts";

type ChangeSectionKey = "intent" | "updates" | "scope" | "plan" | "tasks" | "checks" | "dependencies" | "links";

type ResolvedChangeDocsPath =
  | { ok: true; path: string; absolutePath: string }
  | { ok: false; diagnostics: string[] };

const MarkdownFilePattern = /\.(md|markdown)$/i;
const ChangeSectionTitle: Record<ChangeSectionKey, string> = {
  intent: "Intent",
  updates: "Updates",
  scope: "Scope",
  plan: "Plan",
  tasks: "Tasks",
  checks: "Checks",
  dependencies: "Dependencies",
  links: "Links",
};
const ChangeStyleSections: Record<ChangeRenderStyleType, ChangeSectionKey[]> = {
  narrative: ["intent", "updates", "scope", "plan", "tasks", "checks", "dependencies", "links"],
  checklist: ["intent", "checks", "tasks", "plan", "scope", "updates", "dependencies", "links"],
  reference: ["intent", "updates", "scope", "checks", "plan", "tasks", "dependencies", "links"],
  "architecture-note": ["intent", "scope", "updates", "dependencies", "checks", "plan", "tasks", "links"],
  "decision-record": ["intent", "updates", "scope", "dependencies", "checks", "plan", "tasks", "links"],
};

export function renderChange(change: Change, style: ChangeRenderStyleType, context?: RenderLinkContext): string {
  const linkContext = renderLinkContextForDocs(context, change.render.kind === ChangeRenderKind.Generated ? change.render.docs : context?.currentDocs);
  const lines: string[] = [];
  lines.push(`# ${change.title}`);
  lines.push("");
  lines.push(`Change kind: \`${change.kind}\`.`);

  for (const section of ChangeStyleSections[style]) {
    const rendered = renderChangeSection(change, style, section, linkContext);
    if (rendered.length === 0) continue;
    lines.push("");
    lines.push(`## ${ChangeSectionTitle[section]}`);
    lines.push("");
    lines.push(...rendered);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function changeAnchor(change: Pick<Change, "title">): string {
  return normalizeMarkdownHeading(change.title);
}

export function changeDocsReference(change: Change): string | undefined {
  if (change.render.kind === ChangeRenderKind.None) return undefined;
  return `${change.render.docs}#${changeAnchor(change)}`;
}

export function resolveChangeGeneratedDocsPath(paths: Pick<ContextPaths, "rootDir">, change: Change): ResolvedChangeDocsPath {
  if (change.render.kind !== ChangeRenderKind.Generated) return { ok: false, diagnostics: [`Change ${change.id} is not generated.`] };
  return resolveGeneratedMarkdownPath(paths, `Change ${change.id}`, change.render.docs);
}

export function validateGeneratedChangeDocsPath(owner: string, docsPath: string, context: { paths?: Pick<ContextPaths, "rootDir"> } = {}): string[] {
  const resolved = resolveGeneratedMarkdownPath(context.paths, owner, docsPath);
  return resolved.ok ? [] : resolved.diagnostics;
}

function renderChangeSection(change: Change, style: ChangeRenderStyleType, section: ChangeSectionKey, context: RenderLinkContext | undefined): string[] {
  switch (section) {
    case "intent":
      return renderIntent(change, style);
    case "updates":
      return renderUpdates(change.updates, style, context);
    case "scope":
      return renderScope(change.scope, style);
    case "plan":
      return renderPlan(change, style);
    case "tasks":
      return renderTasks(change, style, context);
    case "checks":
      return renderChecks(change, style);
    case "dependencies":
      return renderDependencies(change, style, context);
    case "links":
      return renderLinks(change, style);
  }
}

function renderIntent(change: Change, style: ChangeRenderStyleType): string[] {
  const rows = [
    ["Problem", change.intent.problem],
    ["Outcome", change.intent.outcome],
    ...(change.intent.why ? ([["Why", change.intent.why]] as Array<[string, string]>) : []),
    ...(change.summary ? ([["Summary", change.summary]] as Array<[string, string]>) : []),
  ];
  switch (style) {
    case ChangeRenderStyle.Narrative:
      return rows.map(([label, value]) => `${label}: ${value}`);
    case ChangeRenderStyle.Checklist:
      return rows.map(([label, value]) => `- [ ] Confirm ${label.toLowerCase()}: ${value}`);
    case ChangeRenderStyle.Reference:
      return rows.map(([label, value]) => `${label}: ${value}`);
    case ChangeRenderStyle.ArchitectureNote:
      return rows.map(([label, value]) => `${label === "Outcome" ? "Architecture outcome" : label}: ${value}`);
    case ChangeRenderStyle.DecisionRecord:
      return rows.map(([label, value]) => `${label === "Outcome" ? "Decision outcome" : label}: ${value}`);
  }
}

function renderUpdates(updates: ChangeUpdates | undefined, style: ChangeRenderStyleType, context: RenderLinkContext | undefined): string[] {
  const rows = updateRows(updates, context);
  if (rows.length === 0) return [];
  return rows.flatMap(([label, values]) => values.map((value) => renderLinkedRow(style, label, value)));
}

function renderScope(scope: ChangeScope | undefined, style: ChangeRenderStyleType): string[] {
  const rows = scopeRows(scope);
  if (rows.length === 0) return [];
  return rows.flatMap(([label, values]) => values.map((value) => renderPlainRow(style, label, value)));
}

function renderPlan(change: Change, style: ChangeRenderStyleType): string[] {
  const plan = change.plan ?? [];
  if (plan.length === 0) return [];
  return plan.flatMap((item, index) => [
    ...(index > 0 ? [""] : []),
    style === ChangeRenderStyle.Checklist ? `- [ ] Plan \`${item.id}\`: ${item.title}` : `Plan \`${item.id}\`: ${item.title}`,
    ...(item.detail ? [`Detail: ${item.detail}`] : []),
    ...(item.checks && item.checks.length > 0 ? [`Checks: ${item.checks.map((check) => checkLink(check)).join(", ")}`] : []),
  ]);
}

function renderTasks(change: Change, style: ChangeRenderStyleType, context: RenderLinkContext | undefined): string[] {
  const tasks = change.tasks ?? [];
  if (tasks.length === 0) return [];
  return tasks.flatMap((task, index) => [
    ...(index > 0 ? [""] : []),
    style === ChangeRenderStyle.Checklist ? `- [ ] Task \`${task.id}\`: ${task.title}` : `Task \`${task.id}\`: ${task.title}`,
    ...(task.detail ? [`Detail: ${task.detail}`] : []),
    ...(task.files && task.files.length > 0 ? [`Files: ${task.files.map((file) => `\`${file}\``).join(", ")}`] : []),
    ...(task.surfaces && task.surfaces.length > 0 ? [`Impact surfaces: ${task.surfaces.map((surface) => renderImpactSurfaceMarkdownLink(context, surface)).join(", ")}`] : []),
    ...(task.checks && task.checks.length > 0 ? [`Checks: ${task.checks.map((check) => checkLink(check)).join(", ")}`] : []),
    ...(task.dependsOn && task.dependsOn.length > 0 ? [`Depends on: ${task.dependsOn.map((id) => `\`${id}\``).join(", ")}`] : []),
    ...(task.blockedBy && task.blockedBy.length > 0 ? [`Blocked by: ${task.blockedBy.map((id) => `\`${id}\``).join(", ")}`] : []),
    ...taskUpdateRows(task.updates, context).map(([label, values]) => `${label}: ${values.join(", ")}`),
  ]);
}

function renderChecks(change: Change, style: ChangeRenderStyleType): string[] {
  const checks = change.checks ?? [];
  if (checks.length === 0) return [];
  return checks.map((check) => (style === ChangeRenderStyle.Checklist ? `- [ ] ${checkSummary(check)}` : `- ${checkSummary(check)}`));
}

function renderDependencies(change: Change, style: ChangeRenderStyleType, context: RenderLinkContext | undefined): string[] {
  const rows = [
    ...((change.dependsOn ?? []).map((id) => `depends on ${renderChangeMarkdownLink(context, id)}`)),
    ...((change.blockedBy ?? []).map((id) => `blocked by ${renderChangeMarkdownLink(context, id)}`)),
  ];
  if (rows.length === 0) return [];
  return rows.map((row) => (style === ChangeRenderStyle.Checklist ? `- [ ] ${row}` : `- ${row}`));
}

function renderLinks(change: Change, style: ChangeRenderStyleType): string[] {
  const rows = [
    ["Commits", change.links?.commits ?? []],
    ["Pull requests", change.links?.pullRequests ?? []],
    ["Issues", change.links?.issues ?? []],
  ].filter((row): row is [string, string[]] => row[1].length > 0);
  if (rows.length === 0) return [];
  return rows.flatMap(([label, values]) => values.map((value) => renderPlainRow(style, label, value)));
}

function updateRows(updates: ChangeUpdates | undefined, context: RenderLinkContext | undefined): Array<[string, string[]]> {
  return [
    ["Areas", (updates?.areas ?? []).map((area) => renderAreaMarkdownLink(context, area))],
    ["Specs", (updates?.specs ?? []).map((spec) => renderSpecMarkdownLink(context, spec))],
    ["Conventions", (updates?.conventions ?? []).map((convention) => renderConventionMarkdownLink(context, convention))],
    ["Impact surfaces", (updates?.surfaces ?? []).map((surface) => renderImpactSurfaceMarkdownLink(context, surface))],
    ["Docs", (updates?.docs ?? []).map((doc) => renderDocsMarkdownLink(context, doc))],
  ].filter((row): row is [string, string[]] => row[1].length > 0);
}

function taskUpdateRows(updates: ChangeUpdates | undefined, context: RenderLinkContext | undefined): Array<[string, string[]]> {
  return updateRows(updates, context);
}

function scopeRows(scope: ChangeScope | undefined): Array<[string, string[]]> {
  return definitionTargetRows(scope);
}

function renderLinkedRow(style: ChangeRenderStyleType, label: string, value: string): string {
  if (style === ChangeRenderStyle.Checklist) return `- [ ] Review ${label.toLowerCase()}: ${value}`;
  return `- ${label}: ${value}`;
}

function renderPlainRow(style: ChangeRenderStyleType, label: string, value: string): string {
  if (style === ChangeRenderStyle.Checklist) return `- [ ] Review ${label.toLowerCase()}: \`${value}\``;
  return `- ${label}: \`${value}\``;
}

function checkSummary(check: ChangeCheck): string {
  switch (check.kind) {
    case ChangeCheckKind.Command:
      return `${checkLink(check.id)} command \`${check.command}\`${check.description ? `: ${check.description}` : ""}`;
    case ChangeCheckKind.Doctor:
      return `${checkLink(check.id)} doctor${check.description ? `: ${check.description}` : ""}`;
    case ChangeCheckKind.Validator:
      return `${checkLink(check.id)} validator \`${check.validatorId}\`${check.description ? `: ${check.description}` : ""}`;
    case ChangeCheckKind.Test:
      return `${checkLink(check.id)} test \`${check.target}\`${check.description ? `: ${check.description}` : ""}`;
  }
}

function checkLink(id: string): string {
  return `\`${id}\``;
}

function resolveGeneratedMarkdownPath(
  paths: Pick<ContextPaths, "rootDir"> | undefined,
  owner: string,
  docsPath: string,
): ResolvedChangeDocsPath {
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
