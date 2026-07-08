import type { Area } from "./area.ts";
import { areaDocsReference } from "./area-render.ts";
import type { Change } from "./change.ts";
import { changeDocsReference } from "./change-render.ts";
import type { ContextPaths, ImpactSurface } from "./core.ts";
import { listProjectFiles, matchesAny, normalizePath, relative, explainGlobMatches } from "./core.ts";
import { ConventionRenderKind, ConventionRuntimeKind, type Convention } from "./convention.ts";
import { conventionDocsReference } from "./convention-render.ts";
import { definitionTargetFiles } from "./definition-target.ts";
import type { Spec } from "./spec.ts";
import { specDocsReference } from "./spec-render.ts";
import { loadImpactSurfaces } from "./context.ts";
import type { RuntimeDefinition, ValidatorRuntime } from "./validator-types.ts";

export function createRuntime(
  paths: ContextPaths,
  conventions: Convention[] = [],
  definitions: { areas?: Area[]; specs?: Spec[]; changes?: Change[] } = {},
): ValidatorRuntime {
  const runtimeConventions = conventions.map(conventionAsRuntimeConvention);
  const runtimeDefinitions = {
    specs: (definitions.specs ?? []).map((spec) => specAsRuntimeDefinition(paths.rootDir, paths.specsPath, spec)),
    areas: (definitions.areas ?? []).map((area) => areaAsRuntimeDefinition(paths.rootDir, paths.areasPath, area)),
    changes: (definitions.changes ?? []).map((change) => changeAsRuntimeDefinition(paths.rootDir, paths.changesPath, change)),
    conventions: conventions.map((convention) => conventionAsRuntimeDefinition(paths.rootDir, paths.conventionsPath, convention)),
  };
  let projectFileCache: string[] | undefined;
  let impactSurfaceCache: ImpactSurface[] | undefined;
  const allDefinitions = () => [
    ...runtimeDefinitions.specs,
    ...runtimeDefinitions.areas,
    ...runtimeDefinitions.changes,
    ...runtimeDefinitions.conventions,
  ];
  const projectFiles = () => {
    projectFileCache ??= listProjectFiles(paths);
    return projectFileCache;
  };
  const impactSurfaces = () => {
    impactSurfaceCache ??= loadImpactSurfaces(paths).surfaces;
    return impactSurfaceCache;
  };
  const definitionFor = (kind: RuntimeDefinition["kind"], id: string) => allDefinitions().find((definition) => definition.kind === kind && definition.id === id);
  const definitionsForFile = (file: string) => {
    const normalized = normalizePath(file);
    return allDefinitions().filter((definition) => definition.targetFiles.some((target) => target === normalized || matchesAny(normalized, [target])));
  };
  const directConventionsForFile = (file: string) => {
    const normalized = normalizePath(file);
    return runtimeConventions.filter((convention) => convention.applies.some((target) => target === normalized || matchesAny(normalized, [target])));
  };
  const surfacesForFile = (file: string) => {
    const normalized = normalizePath(file);
    return impactSurfaces().filter((surface) => matchesAny(normalized, surface.applies));
  };
  const governingConventionsForFile = (file: string) => {
    const linkedIds = surfacesForFile(file).flatMap((surface) => surface.conventionIds ?? []);
    const linked = runtimeConventions.filter((convention) => linkedIds.includes(convention.id));
    return uniqueRuntimeConventions([...directConventionsForFile(file), ...linked]);
  };
  const conventionsForSurface = (surfaceId: string) => {
    const surface = impactSurfaces().find((candidate) => candidate.id === surfaceId);
    if (!surface) return [];
    const linkedIds = new Set(surface.conventionIds ?? []);
    const surfaceFiles = filesForSurface(surfaceId);
    const linked = runtimeConventions.filter((convention) => linkedIds.has(convention.id));
    const inferred = surfaceFiles.flatMap((file) => directConventionsForFile(file));
    return uniqueRuntimeConventions([...linked, ...inferred]);
  };
  const filesForSurface = (surfaceId: string) => {
    const surface = impactSurfaces().find((candidate) => candidate.id === surfaceId);
    return surface ? projectFiles().filter((file) => matchesAny(file, surface.applies)) : [];
  };
  const definitionsForSurface = (surfaceId: string) => {
    const surface = impactSurfaces().find((candidate) => candidate.id === surfaceId);
    if (!surface) return [];
    const surfaceFiles = filesForSurface(surfaceId);
    return allDefinitions().filter((definition) =>
      definition.surfaces.includes(surfaceId) ||
      definition.targetFiles.some((target) => surfaceFiles.some((file) => target === file || matchesAny(file, [target]))),
    );
  };
  const checksForDefinition = (kind: RuntimeDefinition["kind"], id: string) => definitionFor(kind, id)?.checkIds ?? [];
  const checksForSurface = (surfaceId: string) => {
    const surface = impactSurfaces().find((candidate) => candidate.id === surfaceId);
    const definitionChecks = definitionsForSurface(surfaceId).flatMap((definition) => definition.checkIds);
    const policyChecks = [
      ...(surface?.changePolicy?.requiresTests ?? []),
      ...(surface?.changePolicy?.requiresDocs ?? []),
    ];
    return uniqueStrings([...definitionChecks, ...policyChecks]);
  };
  return {
    rootDir: paths.rootDir,
    paths,
    conventions: {
      all: runtimeConventions,
      byId(id) {
        return runtimeConventions.find((convention) => convention.id === id);
      },
      byTopic(topic) {
        return runtimeConventions.filter((convention) => convention.topics.includes(topic));
      },
    },
    definitions: {
      ...runtimeDefinitions,
      all() {
        return allDefinitions();
      },
      byId(kind, id) {
        return definitionFor(kind, id);
      },
    },
    context: {
      definitionsForFile(file) {
        return definitionsForFile(file);
      },
      governingConventionsForFile(file) {
        return governingConventionsForFile(file);
      },
      surfacesForFile(file) {
        return surfacesForFile(file);
      },
      coverageForFile(file) {
        const normalized = normalizePath(file);
        const definitions = definitionsForFile(normalized);
        const conventions = governingConventionsForFile(normalized);
        const surfaces = surfacesForFile(normalized);
        const checks = uniqueStrings([
          ...definitions.flatMap((definition) => definition.checkIds),
          ...surfaces.flatMap((surface) => checksForSurface(surface.id)),
        ]);
        return {
          file: normalized,
          definitions,
          conventions,
          surfaces,
          checks,
          governed: definitions.length + conventions.length + surfaces.length > 0,
        };
      },
      filesForDefinition(kind, id) {
        return definitionFor(kind, id)?.targetFiles ?? [];
      },
      checksForDefinition(kind, id) {
        return checksForDefinition(kind, id);
      },
      filesForSurface(surfaceId) {
        return filesForSurface(surfaceId);
      },
      definitionsForSurface(surfaceId) {
        return definitionsForSurface(surfaceId);
      },
      conventionsForSurface(surfaceId) {
        return conventionsForSurface(surfaceId);
      },
      checksForSurface(surfaceId) {
        return checksForSurface(surfaceId);
      },
    },
    matches(file, globs) {
      return matchesAny(file, globs);
    },
    globs: {
      matches(file, patterns) {
        return matchesAny(file, patterns);
      },
      explain(file, patterns) {
        return explainGlobMatches(file, patterns);
      },
    },
    naming: {
      isPascalCase(value) {
        return /^[A-Z][A-Za-z0-9]*$/.test(value);
      },
      isCamelCase(value) {
        return /^[a-z][A-Za-z0-9]*$/.test(value);
      },
      isKebabCase(value) {
        return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
      },
      isSnakeCase(value) {
        return /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value);
      },
      isScreamingSnakeCase(value) {
        return /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(value);
      },
    },
  };
}

function uniqueRuntimeConventions(conventions: ValidatorRuntime["conventions"]["all"]): ValidatorRuntime["conventions"]["all"] {
  const seen = new Set<string>();
  const result: ValidatorRuntime["conventions"]["all"] = [];
  for (const convention of conventions) {
    if (seen.has(convention.id)) continue;
    seen.add(convention.id);
    result.push(convention);
  }
  return result;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function conventionAsRuntimeConvention(convention: Convention): ValidatorRuntime["conventions"]["all"][number] {
  return {
    id: convention.id,
    title: convention.title,
    topics: convention.topics ?? [],
    applies: conventionAppliesGlobs(convention),
    summary: convention.rule,
    docs: convention.render.kind === ConventionRenderKind.None ? [] : [conventionDocsReference(convention)!],
    validatorIds: convention.runtime.kind === ConventionRuntimeKind.None ? [] : [convention.id],
    rationale: convention.why ? [convention.why] : [],
    examples: (convention.examples ?? []).flatMap((example) => [example.good, example.bad, example.note].filter((item): item is string => Boolean(item))),
  };
}

function conventionAppliesGlobs(convention: Convention): string[] {
  switch (convention.applies.kind) {
    case "files":
    case "symbols":
      return convention.applies.globs;
    case "imports":
      return [...(convention.applies.from ?? []), ...(convention.applies.to ?? [])];
    case "impact-surface":
      return convention.applies.surfaceIds;
    case "definitions":
      return convention.applies.definitions.flatMap((target) => (target.ids ?? []).map((id) => `${target.kind}:${id}`));
    case "project":
      return [convention.applies.describe ?? "project"];
    case "custom":
      return [convention.applies.describe];
  }
}

function specAsRuntimeDefinition(rootDir: string, specsPath: string, spec: Spec): ValidatorRuntime["definitions"]["specs"][number] {
  return {
    kind: "spec",
    id: spec.id,
    title: spec.title,
    summary: spec.summary,
    docs: spec.render.kind === "none" ? [] : [specDocsReference(spec)!],
    source: `${relative(rootDir, specsPath)}#${spec.id}`,
    surfaces: spec.surfaces ?? [],
    conventionIds: spec.governedBy?.conventions ?? [],
    checkIds: (spec.checks ?? []).map((check) => check.id),
    targetFiles: definitionTargetFiles(spec.scope),
  };
}

function areaAsRuntimeDefinition(rootDir: string, areasPath: string, area: Area): ValidatorRuntime["definitions"]["areas"][number] {
  return {
    kind: "area",
    id: area.id,
    title: area.title,
    summary: area.summary,
    docs: area.render.kind === "none" ? [] : [areaDocsReference(area)!],
    source: `${relative(rootDir, areasPath)}#${area.id}`,
    surfaces: area.surfaces ?? [],
    conventionIds: area.governedBy?.conventions ?? [],
    checkIds: (area.checks ?? []).map((check) => check.id),
    targetFiles: definitionTargetFiles(area.owns),
  };
}

function changeAsRuntimeDefinition(rootDir: string, changesPath: string, change: Change): ValidatorRuntime["definitions"]["changes"][number] {
  return {
    kind: "change",
    id: change.id,
    title: change.title,
    summary: change.summary ?? change.intent.outcome,
    docs: change.render.kind === "none" ? [] : [changeDocsReference(change)!],
    source: `${relative(rootDir, changesPath)}#${change.id}`,
    surfaces: change.updates?.surfaces ?? [],
    conventionIds: change.updates?.conventions ?? [],
    checkIds: (change.checks ?? []).map((check) => check.id),
    targetFiles: definitionTargetFiles(change.scope),
  };
}

function conventionAsRuntimeDefinition(rootDir: string, conventionsPath: string, convention: Convention): ValidatorRuntime["definitions"]["conventions"][number] {
  return {
    kind: "convention",
    id: convention.id,
    title: convention.title,
    summary: convention.rule,
    docs: convention.render.kind === ConventionRenderKind.None ? [] : [conventionDocsReference(convention)!],
    source: `${relative(rootDir, conventionsPath)}#${convention.id}`,
    surfaces: convention.impactSurfaces ?? [],
    conventionIds: convention.related ?? [],
    checkIds: convention.runtime.kind === ConventionRuntimeKind.None ? [] : [convention.id],
    targetFiles: convention.applies.kind === "files" || convention.applies.kind === "symbols" ? convention.applies.globs : [],
  };
}
