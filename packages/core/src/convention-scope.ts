import type { ImpactSurface } from "./context.ts";
import { ConventionAppliesKind, ConventionRenderKind, type Applies, type Convention } from "./convention.ts";
import { conventionDocsReference } from "./convention-render.ts";
import { intersects, matchesAny, normalizePath, unique } from "./core-utils.ts";

export const DefaultGoverningConventionLimit = 12;
const defaultAdvisoryFileLimit = 8;
const meaningfulCodeFilePattern = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx|py|rs|svelte|css|scss|sass|less)$/u;

export type ConventionScopeSource = "applies" | "impact-surface" | "explicit";

export type ImpactSurfaceConventionMatch = {
  surface: ImpactSurface;
  files: string[];
  conventionIds: string[];
};

export type ImpactSurfaceConventionResolution = {
  files: string[];
  surfaces: ImpactSurfaceConventionMatch[];
  conventions: Convention[];
  impactSurfaceIdsByConvention: Record<string, string[]>;
};

export type GoverningConventionSummary = {
  id: string;
  title: string;
  rule: string;
  docs: string[];
  sources: ConventionScopeSource[];
  impactSurfaceIds: string[];
};

export type MissingConventionAdvisory = {
  kind: "missing-convention";
  severity: "advisory";
  title: "Missing convention?";
  message: string;
  files: string[];
  omittedFiles: number;
};

export type GoverningConventionsResult = {
  files: string[];
  conventions: GoverningConventionSummary[];
  totalConventions: number;
  omittedConventions: number;
  truncated: boolean;
  impactedSurfaceIds: string[];
  advisory?: MissingConventionAdvisory;
};

export type GoverningConventionOptions = {
  maxConventions?: number;
  maxAdvisoryFiles?: number;
  includeConventionIds?: string[];
};

export function resolveImpactSurfaceConventionsForFiles(input: {
  files: string[];
  impactSurfaces: ImpactSurface[];
  conventions: Convention[];
}): ImpactSurfaceConventionResolution {
  const files = normalizeFiles(input.files);
  const surfaceMatches = [...input.impactSurfaces]
    .filter((surface) => files.some((file) => matchesAny(file, surface.applies)))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((surface) => ({
      surface,
      files: files.filter((file) => matchesAny(file, surface.applies)),
      conventionIds: sortedConventionIdsForSurface(input.conventions, surface.id),
    }));
  const impactedSurfaceIds = new Set(surfaceMatches.map((match) => match.surface.id));
  const impactSurfaceIdsByConvention: Record<string, string[]> = {};
  const conventions = [...input.conventions]
    .sort((left, right) => left.id.localeCompare(right.id))
    .filter((convention) => {
      const surfaceIds = unique((convention.impactSurfaces ?? []).filter((surfaceId) => impactedSurfaceIds.has(surfaceId))).sort();
      if (surfaceIds.length === 0) return false;
      impactSurfaceIdsByConvention[convention.id] = surfaceIds;
      return true;
    });

  return {
    files,
    surfaces: surfaceMatches,
    conventions,
    impactSurfaceIdsByConvention,
  };
}

export function resolveGoverningConventionsForFiles(
  input: {
    files: string[];
    impactSurfaces: ImpactSurface[];
    conventions: Convention[];
  } & GoverningConventionOptions,
): GoverningConventionsResult {
  const files = normalizeFiles(input.files);
  const maxConventions = input.maxConventions ?? DefaultGoverningConventionLimit;
  const maxAdvisoryFiles = input.maxAdvisoryFiles ?? defaultAdvisoryFileLimit;
  const surfaceIdsByFile = impactedSurfaceIdsByFile(files, input.impactSurfaces);
  const impactResolution = resolveImpactSurfaceConventionsForFiles(input);
  const matches = new Map<string, { convention: Convention; sources: Set<ConventionScopeSource>; impactSurfaceIds: Set<string> }>();

  for (const convention of [...input.conventions].sort((left, right) => left.id.localeCompare(right.id))) {
    if (files.some((file) => conventionAppliesToFile(convention, file, surfaceIdsByFile.get(file) ?? new Set()))) {
      upsertConventionMatch(matches, convention, "applies");
    }
  }

  for (const convention of impactResolution.conventions) {
    const match = upsertConventionMatch(matches, convention, "impact-surface");
    for (const surfaceId of impactResolution.impactSurfaceIdsByConvention[convention.id] ?? []) {
      match.impactSurfaceIds.add(surfaceId);
    }
  }

  const conventionById = new Map(input.conventions.map((convention) => [convention.id, convention]));
  for (const conventionId of input.includeConventionIds ?? []) {
    const convention = conventionById.get(conventionId);
    if (convention) upsertConventionMatch(matches, convention, "explicit");
  }

  const allConventions = [...matches.values()]
    .map(({ convention, sources, impactSurfaceIds }) => conventionSummary(convention, sources, impactSurfaceIds))
    .sort((left, right) => left.id.localeCompare(right.id));
  const boundedConventions = maxConventions <= 0 ? [] : allConventions.slice(0, maxConventions);
  const unmatchedFiles = files.filter((file) => isMeaningfulConventionFile(file) && !fileHasConventionCoverage(file, input.conventions, surfaceIdsByFile, impactResolution));
  const advisoryFiles = unmatchedFiles.slice(0, maxAdvisoryFiles);
  const advisory =
    unmatchedFiles.length === 0
      ? undefined
      : {
          kind: "missing-convention" as const,
          severity: "advisory" as const,
          title: "Missing convention?" as const,
          message: "Changed code matched no current convention scope. If this area has a repeatable rule, propose a convention for user ratification.",
          files: advisoryFiles,
          omittedFiles: Math.max(0, unmatchedFiles.length - advisoryFiles.length),
        };

  return {
    files,
    conventions: boundedConventions,
    totalConventions: allConventions.length,
    omittedConventions: Math.max(0, allConventions.length - boundedConventions.length),
    truncated: boundedConventions.length < allConventions.length,
    impactedSurfaceIds: unique(impactResolution.surfaces.map((match) => match.surface.id)).sort(),
    advisory,
  };
}

export function conventionAppliesToFile(convention: Convention, file: string, impactedSurfaceIds = new Set<string>()): boolean {
  const normalized = normalizePath(file);
  switch (convention.applies.kind) {
    case "files":
    case "symbols":
      return matchesAny(normalized, convention.applies.globs);
    case "imports":
      return matchesAny(normalized, appliesGlobs(convention.applies));
    case "impact-surface":
      return intersects(convention.applies.surfaceIds, [...impactedSurfaceIds]);
    case "definitions":
    case "project":
    case "custom":
      return false;
  }
}

export function isMeaningfulConventionFile(file: string): boolean {
  return meaningfulCodeFilePattern.test(normalizePath(file));
}

function upsertConventionMatch(
  matches: Map<string, { convention: Convention; sources: Set<ConventionScopeSource>; impactSurfaceIds: Set<string> }>,
  convention: Convention,
  source: ConventionScopeSource,
): { convention: Convention; sources: Set<ConventionScopeSource>; impactSurfaceIds: Set<string> } {
  const current = matches.get(convention.id) ?? { convention, sources: new Set<ConventionScopeSource>(), impactSurfaceIds: new Set<string>() };
  current.sources.add(source);
  matches.set(convention.id, current);
  return current;
}

function conventionSummary(convention: Convention, sources: Set<ConventionScopeSource>, impactSurfaceIds: Set<string>): GoverningConventionSummary {
  return {
    id: convention.id,
    title: convention.title,
    rule: convention.rule,
    docs: convention.render.kind === ConventionRenderKind.None ? [] : [conventionDocsReference(convention)!],
    sources: [...sources].sort(),
    impactSurfaceIds: [...impactSurfaceIds].sort(),
  };
}

function fileHasConventionCoverage(
  file: string,
  conventions: Convention[],
  surfaceIdsByFile: Map<string, Set<string>>,
  impactResolution: ImpactSurfaceConventionResolution,
): boolean {
  const impactedSurfaceIds = surfaceIdsByFile.get(file) ?? new Set<string>();
  if (conventions.some((convention) => conventionAppliesToFile(convention, file, impactedSurfaceIds))) return true;
  const impactedSurfaceConventions = new Set(
    impactResolution.surfaces
      .filter((match) => match.files.includes(file))
      .flatMap((match) => match.conventionIds),
  );
  return impactedSurfaceConventions.size > 0;
}

function impactedSurfaceIdsByFile(files: string[], surfaces: ImpactSurface[]): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const file of files) {
    const ids = surfaces.filter((surface) => matchesAny(file, surface.applies)).map((surface) => surface.id);
    byFile.set(file, new Set(ids));
  }
  return byFile;
}

function sortedConventionIdsForSurface(conventions: Convention[], surfaceId: string): string[] {
  return conventions
    .filter((convention) => (convention.impactSurfaces ?? []).includes(surfaceId))
    .map((convention) => convention.id)
    .sort();
}

function appliesGlobs(applies: Applies): string[] {
  if (applies.kind === ConventionAppliesKind.Files || applies.kind === ConventionAppliesKind.Symbols) return applies.globs;
  if (applies.kind === ConventionAppliesKind.Imports) return [...(applies.from ?? []), ...(applies.to ?? [])];
  return [];
}

function normalizeFiles(files: string[]): string[] {
  return unique(files.map((file) => normalizePath(file)).filter(Boolean)).sort();
}
