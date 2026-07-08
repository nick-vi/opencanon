import type { ContextPaths } from "./context.ts";
import { ConventionRenderKind, ConventionRenderStyle, ConventionRuntimeKind, type Applies, type Convention, type RenderStyle, type Runtime } from "./convention.ts";
import { normalizeMarkdownHeading } from "./docs.ts";
import { resolveInsideRoot } from "./paths.ts";

type SectionKey = "why" | "rule" | "applies" | "examples" | "runtime" | "impactSurfaces" | "related";

type ResolvedConventionDocsPath =
  | { ok: true; path: string; absolutePath: string }
  | { ok: false; diagnostics: string[] };

const MarkdownFilePattern = /\.(md|markdown)$/i;
const SectionTitle: Record<SectionKey, string> = {
  why: "Why",
  rule: "Rule",
  applies: "Applies to",
  examples: "Examples",
  runtime: "Runtime checks",
  impactSurfaces: "Related impact surfaces",
  related: "Related conventions",
};
const StyleSections: Record<RenderStyle, SectionKey[]> = {
  narrative: ["why", "rule", "applies", "examples", "runtime", "impactSurfaces", "related"],
  checklist: ["rule", "applies", "runtime", "examples", "why", "related", "impactSurfaces"],
  reference: ["rule", "applies", "runtime", "why", "examples", "impactSurfaces", "related"],
  "architecture-note": ["why", "applies", "rule", "impactSurfaces", "runtime", "examples", "related"],
  "decision-record": ["rule", "why", "applies", "runtime", "related", "impactSurfaces", "examples"],
};

export function renderConvention(convention: Convention, style: RenderStyle): string {
  const lines: string[] = [];
  lines.push(`# ${convention.title}`);
  lines.push("");
  lines.push(`Convention id: \`${convention.id}\`.`);

  for (const section of StyleSections[style]) {
    const rendered = renderSection(convention, style, section);
    if (rendered.length === 0) continue;
    lines.push("");
    lines.push(`## ${SectionTitle[section]}`);
    lines.push("");
    lines.push(...rendered);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function conventionAnchor(convention: Pick<Convention, "title">): string {
  return normalizeMarkdownHeading(convention.title);
}

export function conventionDocsReference(convention: Convention): string | undefined {
  if (convention.render.kind === ConventionRenderKind.None) return undefined;
  return `${convention.render.docs}#${conventionAnchor(convention)}`;
}

export function resolveConventionGeneratedDocsPath(paths: Pick<ContextPaths, "rootDir">, convention: Convention): ResolvedConventionDocsPath {
  if (convention.render.kind !== ConventionRenderKind.Generated) return { ok: false, diagnostics: [`Convention ${convention.id} is not generated.`] };
  return resolveGeneratedMarkdownPath(paths, `Convention ${convention.id}`, convention.render.docs);
}

export function validateGeneratedConventionDocsPath(owner: string, docsPath: string, context: { paths?: Pick<ContextPaths, "rootDir"> } = {}): string[] {
  const resolved = resolveGeneratedMarkdownPath(context.paths, owner, docsPath);
  return resolved.ok ? [] : resolved.diagnostics;
}

function renderSection(convention: Convention, style: RenderStyle, section: SectionKey): string[] {
  switch (section) {
    case "why":
      return renderWhy(convention, style);
    case "rule":
      return renderRule(convention, style);
    case "applies":
      return renderApplies(convention.applies, style);
    case "examples":
      return renderExamples(convention, style);
    case "runtime":
      return renderRuntime(convention.runtime, style);
    case "impactSurfaces":
      return renderImpactSurfaces(convention, style);
    case "related":
      return renderRelatedConventions(convention, style);
  }
}

function renderWhy(convention: Convention, style: RenderStyle): string[] {
  const why = convention.why;
  if (!why) return [];
  switch (style) {
    case "narrative":
      return [why];
    case "checklist":
      return [`- [ ] Confirm the rationale: ${why}`];
    case "reference":
      return [why];
    case "architecture-note":
      return [why];
    case "decision-record":
      return [why];
  }
}

function renderRule(convention: Convention, style: RenderStyle): string[] {
  switch (style) {
    case "narrative":
      return [`The convention is: ${convention.rule}`];
    case "checklist":
      return [`- [ ] Enforce: ${convention.rule}`];
    case "reference":
      return [convention.rule];
    case "architecture-note":
      return [convention.rule];
    case "decision-record":
      return [convention.rule];
  }
}

function renderApplies(applies: Applies, style: RenderStyle): string[] {
  const details = appliesDetails(applies);
  switch (style) {
    case "narrative":
      return ["This convention applies to:", ...details.map((detail) => `- ${detail}`)];
    case "checklist":
      return details.map((detail) => `- [ ] Check ${detail}`);
    case "reference":
      return details.map((detail) => `- ${detail}`);
    case "architecture-note":
      return ["Affected architecture scope:", ...details.map((detail) => `- ${detail}`)];
    case "decision-record":
      return ["Scope of the decision:", ...details.map((detail) => `- ${detail}`)];
  }
}

function renderExamples(convention: Convention, style: RenderStyle): string[] {
  const examples = convention.examples ?? [];
  if (examples.length === 0) return [];

  const lines: string[] = [];
  examples.forEach((example, index) => {
    if (index > 0) lines.push("");
    const prefix = style === ConventionRenderStyle.Checklist ? "- [ ] " : "";
    if (example.good) lines.push(...labeledBlock("Good", example.good, style));
    if (example.bad) lines.push(...labeledBlock("Bad", example.bad, style));
    if (example.note) lines.push(`${prefix || "- "}${example.note}`);
  });
  return lines;
}

function renderRuntime(runtime: Runtime, style: RenderStyle): string[] {
  if (runtime.kind === ConventionRuntimeKind.None) return [];
  const rows = runtimeDetails(runtime);
  switch (style) {
    case "narrative":
      return ["Runtime enforcement is configured as:", ...rows.map(([label, value]) => `- ${label}: ${value}`)];
    case "checklist":
      return rows.map(([label, value]) => `- [ ] Verify ${label.toLowerCase()}: ${value}`);
    case "reference":
      return rows.map(([label, value]) => `- ${label}: ${value}`);
    case "architecture-note":
      return ["Runtime guardrails:", ...rows.map(([label, value]) => `- ${label}: ${value}`)];
    case "decision-record":
      return ["Enforcement recorded for this decision:", ...rows.map(([label, value]) => `- ${label}: ${value}`)];
  }
}

function renderImpactSurfaces(convention: Convention, style: RenderStyle): string[] {
  const surfaces = convention.impactSurfaces ?? [];
  if (surfaces.length === 0) return [];
  const linked = surfaces.map((id) => impactSurfaceLink(id));
  switch (style) {
    case "narrative":
      return ["Related impact surfaces:", ...linked.map((item) => `- ${item}`)];
    case "checklist":
      return linked.map((item) => `- [ ] Review impact surface ${item}`);
    case "reference":
      return linked.map((item) => `- ${item}`);
    case "architecture-note":
      return ["Architecture surfaces affected:", ...linked.map((item) => `- ${item}`)];
    case "decision-record":
      return ["Impact surfaces considered:", ...linked.map((item) => `- ${item}`)];
  }
}

function renderRelatedConventions(convention: Convention, style: RenderStyle): string[] {
  const related = convention.related ?? [];
  if (related.length === 0) return [];
  const linked = related.map((id) => conventionLink(id));
  switch (style) {
    case "narrative":
      return ["Related conventions:", ...linked.map((item) => `- ${item}`)];
    case "checklist":
      return linked.map((item) => `- [ ] Compare with ${item}`);
    case "reference":
      return linked.map((item) => `- ${item}`);
    case "architecture-note":
      return ["Neighboring convention constraints:", ...linked.map((item) => `- ${item}`)];
    case "decision-record":
      return ["Related convention records:", ...linked.map((item) => `- ${item}`)];
  }
}

function appliesDetails(applies: Applies): string[] {
  switch (applies.kind) {
    case "files":
      return applies.globs.map((glob) => `\`${glob}\``);
    case "symbols":
      return [
        ...applies.globs.map((glob) => `symbol files \`${glob}\``),
        ...(applies.symbolKinds && applies.symbolKinds.length > 0 ? [`symbol kinds: ${applies.symbolKinds.map((kind) => `\`${kind}\``).join(", ")}`] : []),
      ];
    case "imports":
      return [
        ...(applies.from ?? []).map((glob) => `from \`${glob}\``),
        ...(applies.to ?? []).map((glob) => `to \`${glob}\``),
        ...((applies.from ?? []).length === 0 && (applies.to ?? []).length === 0 ? ["all import edges"] : []),
      ];
    case "impact-surface":
      return applies.surfaceIds.map((id) => `impact surface ${impactSurfaceLink(id)}`);
    case "definitions":
      return applies.definitions.map((target) => {
        const ids = target.ids && target.ids.length > 0 ? target.ids.map((id) => definitionLink(target.kind, id)).join(", ") : "all";
        return `${target.kind} definitions: ${ids}`;
      });
    case "project":
      return [applies.describe ?? "the whole project"];
    case "custom":
      return [applies.describe];
  }
}

function runtimeDetails(runtime: Exclude<Runtime, { kind: "none" }>): Array<[string, string]> {
  return [
    ["Kind", `\`${runtime.kind}\``],
    ["Severity", `\`${runtime.kind === ConventionRuntimeKind.Gate ? "error" : runtime.severity}\``],
    ["Scope", `\`${runtime.scope}\``],
    ...(runtime.domain ? ([["Domain", `\`${runtime.domain}\``]] as Array<[string, string]>) : []),
    ...(runtime.facts.length > 0 ? ([["Facts", runtime.facts.map((fact) => `\`${fact}\``).join(", ")]] as Array<[string, string]>) : []),
    ...(runtime.kind === ConventionRuntimeKind.Gate ? ([["Question", runtime.question]] as Array<[string, string]>) : []),
    ...(runtime.requiresProducers && runtime.requiresProducers.length > 0
      ? ([["Requires producers", runtime.requiresProducers.map((producer) => `\`${producer}\``).join(", ")]] as Array<[string, string]>)
      : []),
    ...(runtime.fixtures ? ([["Fixtures", `\`${runtime.fixtures}\``]] as Array<[string, string]>) : []),
  ];
}

function labeledBlock(label: string, value: string, style: RenderStyle): string[] {
  const prefix = style === ConventionRenderStyle.Checklist ? `- [ ] ${label}:` : `${label}:`;
  return [prefix, fenceBlock(value)];
}

function conventionLink(id: string): string {
  return `[${id}](opencanon://conventions/${encodeURIComponent(id)})`;
}

function impactSurfaceLink(id: string): string {
  return `[${id}](opencanon://impact-surfaces/${encodeURIComponent(id)})`;
}

function definitionLink(kind: string, id: string): string {
  return `[${id}](opencanon://${definitionRoute(kind)}/${encodeURIComponent(id)})`;
}

function definitionRoute(kind: string): string {
  switch (kind) {
    case "area":
      return "areas";
    case "spec":
      return "specs";
    case "change":
      return "changes";
    case "convention":
      return "conventions";
    default:
      return `${kind}s`;
  }
}

function fenceBlock(value: string): string {
  const matches = value.match(/`+/g) ?? [];
  const longest = matches.reduce((max, match) => Math.max(max, match.length), 2);
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${value}\n${fence}`;
}

function resolveGeneratedMarkdownPath(
  paths: Pick<ContextPaths, "rootDir"> | undefined,
  owner: string,
  docsPath: string,
): ResolvedConventionDocsPath {
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
