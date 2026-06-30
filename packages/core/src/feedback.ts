import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Format, createPaths, intersects, matchesAny, resolveRootDir, toRepoRelativePath, unique, validateConfig } from "./core.ts";
import type { ImpactSurface } from "./context.ts";
import type { GoverningConventionsResult, MissingConventionAdvisory } from "./convention-scope.ts";
import { isMeaningfulConventionFile } from "./convention-scope.ts";
import { AreaRenderKind, type Area } from "./area.ts";
import type { Change, ChangeKind, ChangeUpdates } from "./change.ts";
import { definitionTargetDocs, definitionTargetFiles } from "./definition-target.ts";
import type { Finding } from "./validator.ts";
import { loadProjectContext } from "./project.ts";
import { runValidation } from "./validation.ts";
import { writeAtomicJsonFileSync } from "./atomic.ts";

// Single source of truth for feedback hosts; reference members instead of inlining the strings.
export const FeedbackHost = { Manual: "manual", Codex: "codex", Claude: "claude", OpenCode: "opencode" } as const;
export type FeedbackHost = (typeof FeedbackHost)[keyof typeof FeedbackHost];
// Single source of truth for feedback dedupe scopes; reference members instead of inlining the strings.
export const FeedbackDedupeScope = { Off: "off", Turn: "turn", Session: "session" } as const;
export type FeedbackDedupeScope = (typeof FeedbackDedupeScope)[keyof typeof FeedbackDedupeScope];

export type FeedbackInput = {
  cwd: string;
  files: string[];
  host?: FeedbackHost;
  sessionId?: string;
  turnId?: string;
  dedupeScope?: FeedbackDedupeScope;
};

export type FeedbackResult = {
  host: FeedbackHost;
  files: string[];
  diagnostics: string[];
  findingCount: number;
  suppressedCount: number;
  findings: Finding[];
  governingConventions?: GoverningConventionsResult;
  advisories?: MissingConventionAdvisory[];
  change?: FeedbackChangeContext;
};

export type FeedbackChangeContext = {
  impactedSurfaces: FeedbackImpactSurface[];
  areas: FeedbackArea[];
  changes: FeedbackChange[];
  scopeDrift?: FeedbackScopeDrift;
};

export type FeedbackImpactSurface = {
  id: string;
  title: string;
  files: string[];
  risks: string[];
  docs: string[];
};

export type FeedbackArea = {
  id: string;
  title: string;
  summary: string;
  surfaces: string[];
  docs: string[];
  matches: string[];
};

export type FeedbackChange = {
  id: string;
  title: string;
  kind: ChangeKind;
  summary: string;
  docs: string[];
  scope: {
    files: string[];
    docs: string[];
  };
  updates: Required<Pick<ChangeUpdates, "areas" | "conventions" | "surfaces" | "docs">>;
  matches: string[];
};

export type FeedbackScopeDrift = {
  kind: "scope-drift";
  severity: "advisory";
  title: "Scope drift?";
  message: string;
  files: string[];
  omittedFiles: number;
};

type FeedbackCache = {
  scopes: Record<string, string[]>;
};

export async function runFeedback(input: FeedbackInput): Promise<FeedbackResult> {
  const rootDir = resolveRootDir(input.cwd);
  const paths = createPaths(rootDir);
  const host = input.host ?? "manual";
  const files = unique(input.files.map((file) => toRepoRelativePath(rootDir, file, input.cwd)));
  const diagnostics = validateConfig(paths);

  if (files.length === 0) {
    return {
      host,
      files,
      diagnostics,
      findingCount: 0,
      suppressedCount: 0,
      findings: [],
    };
  }

  if (diagnostics.length > 0) {
    return {
      host,
      files,
      diagnostics,
      findingCount: 0,
      suppressedCount: 0,
      findings: [],
    };
  }

  let project: Awaited<ReturnType<typeof loadProjectContext>>;
  try {
    project = await loadProjectContext(rootDir);
  } catch (error) {
    return {
      host,
      files,
      diagnostics: [error instanceof Error ? error.message : String(error)],
      findingCount: 0,
      suppressedCount: 0,
      findings: [],
    };
  }

  const validation = await runValidation({
    rootDir,
    paths,
    conventions: project.conventions,
    validators: project.validators,
    files,
  });
  const change = resolveFeedbackChangeContext({
    files,
    areas: project.areas,
    changes: project.changes,
    impactSurfaces: project.impactSurfaces,
  });
  const deduped = filterFeedbackFindings({
    cacheFile: path.join(paths.cacheDir, "feedback.json"),
    findings: validation.findings,
    scopeKey: feedbackScopeKey({
      host,
      sessionId: input.sessionId,
      turnId: input.turnId,
      dedupeScope: input.dedupeScope ?? "turn",
    }),
  });

  return {
    host,
    files,
    diagnostics: [...validation.diagnostics, ...deduped.diagnostics],
    findingCount: deduped.findings.length,
    suppressedCount: deduped.suppressedCount,
    findings: deduped.findings,
    governingConventions: validation.governingConventions,
    advisories: validation.governingConventions?.advisory ? [validation.governingConventions.advisory] : [],
    change,
  };
}

export type FeedbackRenderOptions = {
  emptyMessage?: boolean;
  maxFindings?: number;
  maxChars?: number;
};

export function renderFeedbackMarkdown(result: FeedbackResult, options: FeedbackRenderOptions = {}): string {
  const maxFindings = options.maxFindings ?? 20;
  const maxChars = options.maxChars ?? 6000;
  const lines: string[] = [];
  const advisories = result.advisories ?? [];
  const governingConventions = result.governingConventions;

  if (
    result.findings.length === 0 &&
    result.diagnostics.length === 0 &&
    advisories.length === 0 &&
    !hasFeedbackChange(result.change) &&
    (!governingConventions || governingConventions.conventions.length === 0)
  ) {
    return options.emptyMessage ? "No OpenCanon feedback." : "";
  }

  lines.push("# OpenCanon Feedback");
  lines.push("");
  lines.push(`Host: ${result.host}`);
  lines.push(`Files: ${result.files.length > 0 ? result.files.join(", ") : "<none>"}`);
  if (result.files.length > 0) lines.push(`Run: ${validationCommand(result.files)}`);

  if (result.diagnostics.length > 0) {
    lines.push("");
    lines.push("Diagnostics:");
    for (const diagnostic of result.diagnostics) lines.push(`- ${diagnostic}`);
  }

  if (governingConventions && governingConventions.conventions.length > 0) {
    lines.push("");
    lines.push("Relevant Conventions:");
    for (const convention of governingConventions.conventions) {
      lines.push(`- ${convention.id}: ${convention.title}`);
      lines.push(`  Rule: ${convention.rule}`);
      if (convention.docs.length > 0) lines.push(`  Docs: ${convention.docs.join(", ")}`);
      if (convention.impactSurfaceIds.length > 0) lines.push(`  Impact surfaces: ${convention.impactSurfaceIds.join(", ")}`);
    }
    if (governingConventions.truncated) {
      lines.push(`- ${governingConventions.omittedConventions} more relevant convention(s) omitted from hook feedback.`);
    }
  }

  if (hasFeedbackChange(result.change)) {
    lines.push("");
    lines.push("Change Context:");

    if (result.change.changes.length > 0) {
      lines.push("");
      lines.push("Related Changes:");
      for (const change of result.change.changes) {
        lines.push(`- ${change.id}: ${change.title} (${change.kind})`);
        lines.push(`  ${change.summary}`);
        if (change.matches.length > 0) lines.push(`  Matched by: ${change.matches.join(", ")}`);
        if (change.scope.files.length > 0) lines.push(`  Scope files: ${change.scope.files.join(", ")}`);
        if (change.docs.length > 0) lines.push(`  Docs: ${change.docs.join(", ")}`);
      }
    }

    if (result.change.areas.length > 0) {
      lines.push("");
      lines.push("Affected Areas:");
      for (const area of result.change.areas) {
        lines.push(`- ${area.id}: ${area.title}`);
        lines.push(`  ${area.summary}`);
        if (area.matches.length > 0) lines.push(`  Matched by: ${area.matches.join(", ")}`);
        if (area.surfaces.length > 0) lines.push(`  Surfaces: ${area.surfaces.join(", ")}`);
        if (area.docs.length > 0) lines.push(`  Docs: ${area.docs.join(", ")}`);
      }
    }

    if (result.change.impactedSurfaces.length > 0) {
      lines.push("");
      lines.push("Affected Impact Surfaces:");
      for (const surface of result.change.impactedSurfaces) {
        lines.push(`- ${surface.id}: ${surface.title}`);
        lines.push(`  Files: ${surface.files.join(", ")}`);
        if (surface.risks.length > 0) lines.push(`  Risks: ${surface.risks.join(", ")}`);
        if (surface.docs.length > 0) lines.push(`  Docs: ${surface.docs.join(", ")}`);
      }
    }

    if (result.change.scopeDrift) {
      lines.push("");
      lines.push("Scope Drift:");
      lines.push(`- [${result.change.scopeDrift.severity}] ${result.change.scopeDrift.title}`);
      lines.push(`  ${result.change.scopeDrift.message}`);
      lines.push(`  Files: ${result.change.scopeDrift.files.join(", ")}${result.change.scopeDrift.omittedFiles > 0 ? `, and ${result.change.scopeDrift.omittedFiles} more` : ""}`);
      lines.push("  Update the change definition, split unrelated hygiene into a separate change, or get explicit user approval.");
    }
  }

  if (advisories.length > 0) {
    lines.push("");
    lines.push("Advisories:");
    for (const advisory of advisories) {
      lines.push(`- [${advisory.severity}] ${advisory.title}`);
      lines.push(`  ${advisory.message}`);
      lines.push(`  Files: ${advisory.files.join(", ")}${advisory.omittedFiles > 0 ? `, and ${advisory.omittedFiles} more` : ""}`);
      lines.push("  This is advisory only; it does not block commits or CI.");
    }
  }

  if (result.findings.length > 0) {
    lines.push("");
    lines.push(`Findings: ${result.findings.length}`);
    let renderedFindings = 0;
    for (const [file, findings] of groupFindingsByFile(result.findings)) {
      if (renderedFindings >= maxFindings) break;
      lines.push("");
      lines.push(`## ${file}`);
      for (const finding of findings) {
        if (renderedFindings >= maxFindings) break;
        lines.push(`- [${finding.severity}] line ${finding.line} ${finding.validatorId}`);
        lines.push(`  ${finding.message}`);
        if (finding.fix) lines.push(`  Fix (${finding.fix.safety}): ${finding.fix.description}`);
        if (finding.fix?.command) lines.push(`  Command: ${finding.fix.command}`);
        if (finding.conventionIds && finding.conventionIds.length > 0) lines.push(`  Conventions: ${finding.conventionIds.join(", ")}`);
        if (finding.docs && finding.docs.length > 0) lines.push(`  Docs: ${finding.docs.join(", ")}`);
        renderedFindings += 1;
      }
    }
    const hiddenFindings = result.findings.length - renderedFindings;
    if (hiddenFindings > 0) lines.push(`- ${hiddenFindings} more finding(s) omitted from hook feedback.`);
    if (result.findings.length > 0) {
      lines.push("");
      lines.push("Finding Resolution Policy: any finding must be addressed before the agent completes the task. Fix code to current canon, or fix the convention plus fixtures if the rule is wrong.");
      lines.push("Audit exceptions: opencanon context --list-exceptions");
    }
  }

  if (result.suppressedCount > 0) {
    lines.push("");
    lines.push(`Suppressed repeated findings in this hook scope: ${result.suppressedCount}`);
  }

  return trimToBudget(lines.join("\n"), maxChars);
}

export function formatFeedbackResult(result: FeedbackResult, format: Format, options: FeedbackRenderOptions = {}): string {
  if (format === Format.Json) return JSON.stringify(result, null, 2);
  return renderFeedbackMarkdown(result, options);
}

function groupFindingsByFile(findings: Finding[]): Array<[string, Finding[]]> {
  const grouped = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = grouped.get(finding.file) ?? [];
    group.push(finding);
    grouped.set(finding.file, group);
  }
  return [...grouped.entries()];
}

function validationCommand(files: string[]): string {
  return `opencanon validate --files ${files.map(quoteShell).join(" ")}`;
}

function resolveFeedbackChangeContext(input: {
  files: string[];
  areas: Area[];
  changes: Change[];
  impactSurfaces: ImpactSurface[];
}): FeedbackChangeContext | undefined {
  const impactedSurfaces = input.impactSurfaces
    .map((surface) => {
      const files = input.files.filter((file) => matchesAny(file, surface.applies));
      return files.length > 0 ? feedbackImpactSurface(surface, files) : undefined;
    })
    .filter((surface): surface is FeedbackImpactSurface => surface !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  const impactedSurfaceIds = impactedSurfaces.map((surface) => surface.id);
  const areas = input.areas
    .map((area) => feedbackArea(area, { files: input.files, impactedSurfaceIds }))
    .filter((area): area is FeedbackArea => area !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  const areaIds = areas.map((area) => area.id);
  const changes = input.changes
    .map((change) =>
      feedbackChange(change, {
        files: input.files,
        areaIds,
        impactedSurfaceIds,
      }),
    )
    .filter((change): change is FeedbackChange => change !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  const scopeDrift = feedbackScopeDrift(input.files, input.changes);
  const change = { impactedSurfaces, areas, changes, scopeDrift };
  return hasFeedbackChange(change) ? change : undefined;
}

function feedbackImpactSurface(surface: ImpactSurface, files: string[]): FeedbackImpactSurface {
  return {
    id: surface.id,
    title: surface.title ?? surface.id,
    files,
    risks: surface.risks ?? [],
    docs: surface.docs ?? [],
  };
}

function feedbackArea(area: Area, context: { files: string[]; impactedSurfaceIds: string[] }): FeedbackArea | undefined {
  const matches: string[] = [];
  if (matchesAnyInputFile(context.files, definitionTargetFiles(area.owns))) matches.push("owned files");
  if (intersects(context.files, definitionTargetDocs(area.owns))) matches.push("owned docs");
  if (intersects(area.surfaces ?? [], context.impactedSurfaceIds)) matches.push("impact surfaces");
  if (matches.length === 0) return undefined;
  return {
    id: area.id,
    title: area.title,
    summary: area.summary,
    surfaces: area.surfaces ?? [],
    docs: definitionDocs(area.render),
    matches,
  };
}

function feedbackChange(
  change: Change,
  context: {
    files: string[];
    areaIds: string[];
    impactedSurfaceIds: string[];
  },
): FeedbackChange | undefined {
  const scopeFiles = definitionTargetFiles(change.scope);
  const scopeDocs = definitionTargetDocs(change.scope);
  const updates = {
    areas: change.updates?.areas ?? [],
    conventions: change.updates?.conventions ?? [],
    surfaces: change.updates?.surfaces ?? [],
    docs: change.updates?.docs ?? [],
  };
  const matches: string[] = [];
  if (matchesAnyInputFile(context.files, scopeFiles)) matches.push("scope files");
  if (intersects(context.files, scopeDocs)) matches.push("scope docs");
  if (intersects(updates.areas, context.areaIds)) matches.push("updated areas");
  if (intersects(updates.surfaces, context.impactedSurfaceIds)) matches.push("updated surfaces");
  if (intersects(context.files, updates.docs)) matches.push("updated docs");
  if (matches.length === 0) return undefined;
  return {
    id: change.id,
    title: change.title,
    kind: change.kind,
    summary: change.summary ?? change.intent.outcome,
    docs: definitionDocs(change.render),
    scope: {
      files: scopeFiles,
      docs: scopeDocs,
    },
    updates,
    matches,
  };
}

function feedbackScopeDrift(files: string[], changes: Change[]): FeedbackScopeDrift | undefined {
  const driftFiles = files.filter((file) => isMeaningfulConventionFile(file) && !changes.some((change) => changeCoversFile(change, file)));
  if (driftFiles.length === 0) return undefined;
  const visibleFiles = driftFiles.slice(0, 8);
  const message =
    changes.length === 0
      ? "No committed change definition covers these edited files. Create or ratify a change definition for meaningful change."
      : "Edited files are outside the scope of every committed change definition.";
  return {
    kind: "scope-drift",
    severity: "advisory",
    title: "Scope drift?",
    message,
    files: visibleFiles,
    omittedFiles: Math.max(0, driftFiles.length - visibleFiles.length),
  };
}

function changeCoversFile(change: Change, file: string): boolean {
  return matchesAny(file, definitionTargetFiles(change.scope)) || definitionTargetDocs(change.scope).includes(file);
}

function matchesAnyInputFile(files: string[], globs: string[]): boolean {
  return files.some((file) => matchesAny(file, globs));
}

function definitionDocs(render: { kind: "generated"; docs: string } | { kind: "none" }): string[] {
  return render.kind === AreaRenderKind.None ? [] : [render.docs];
}

function hasFeedbackChange(change: FeedbackChangeContext | undefined): change is FeedbackChangeContext {
  return Boolean(change && (change.changes.length > 0 || change.areas.length > 0 || change.impactedSurfaces.length > 0 || change.scopeDrift));
}

function quoteShell(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function trimToBudget(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const marker = "\n\nOutput truncated. Run the validation command above for the full report.";
  return `${text.slice(0, Math.max(0, maxChars - marker.length)).trimEnd()}${marker}`;
}

function feedbackScopeKey(input: {
  host: FeedbackHost;
  sessionId?: string;
  turnId?: string;
  dedupeScope: FeedbackDedupeScope;
}): string | null {
  if (input.dedupeScope === FeedbackDedupeScope.Off) return null;
  if (input.dedupeScope === FeedbackDedupeScope.Turn) {
    if (!input.turnId) return null;
    return `${input.host}:turn:${input.sessionId ?? "unknown"}:${input.turnId}`;
  }
  if (!input.sessionId) return null;
  return `${input.host}:session:${input.sessionId}`;
}

function filterFeedbackFindings(params: {
  cacheFile: string;
  findings: Finding[];
  scopeKey: string | null;
}): { findings: Finding[]; suppressedCount: number; diagnostics: string[] } {
  if (!params.scopeKey) return { findings: params.findings, suppressedCount: 0, diagnostics: [] };
  const diagnostics: string[] = [];
  let cache = readFeedbackCache(params.cacheFile);
  const seen = new Set(cache.scopes[params.scopeKey] ?? []);
  const next: Finding[] = [];
  let suppressedCount = 0;

  for (const finding of params.findings) {
    const fingerprint = fingerprintFinding(finding);
    if (seen.has(fingerprint)) {
      suppressedCount += 1;
      continue;
    }
    seen.add(fingerprint);
    next.push(finding);
  }

  cache = {
    scopes: {
      ...cache.scopes,
      [params.scopeKey]: [...seen],
    },
  };

  try {
    mkdirSync(path.dirname(params.cacheFile), { recursive: true });
    writeAtomicJsonFileSync(params.cacheFile, cache);
  } catch (error) {
    diagnostics.push(`Could not write feedback cache: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { findings: next, suppressedCount, diagnostics };
}

function readFeedbackCache(cacheFile: string): FeedbackCache {
  if (!existsSync(cacheFile)) return { scopes: {} };
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, "utf8")) as Partial<FeedbackCache>;
    if (!parsed || typeof parsed !== "object" || !parsed.scopes || typeof parsed.scopes !== "object") return { scopes: {} };
    return { scopes: parsed.scopes };
  } catch {
    return { scopes: {} };
  }
}

function fingerprintFinding(finding: Finding): string {
  return createHash("sha256")
    .update([finding.validatorId, finding.severity, finding.file, finding.line, finding.column ?? 0, finding.message].join("\0"))
    .digest("hex");
}
