import { createHash } from "node:crypto";
import {
  createOpenCanonDiagnostic,
  createOpenCanonFailure,
  definitionTargetDocs,
  definitionTargetFiles,
  getGitFileDiff,
  getGitFileHistory,
  intersects,
  matchesAny,
  matchesAnyFile,
  resolveDocsReferences,
  type CanonFinding,
  type ImpactSurface,
} from "@opencanon/core";
import type { RelatedCanon, RelatedCanonQuery, RuntimeSnapshot, SnapshotArea, SnapshotChange, SnapshotConvention, SnapshotSpec, SnapshotValidator } from "./snapshot.ts";
import { docsBySnapshotConvention, unique, uniqueById } from "./snapshot-projection.ts";

export function buildRelatedCanon(input: { rootDir: string; paths: { conventionsPath: string; rootDir: string }; snapshot: RuntimeSnapshot; query: RelatedCanonQuery }): RelatedCanon {
  const files = unique(input.query.files ?? []);
  const topics = new Set(input.query.topics ?? []);
  const conventionIds = new Set(input.query.conventionIds ?? []);
  const validatorIds = new Set(input.query.validatorIds ?? []);
  const findingIds = new Set(input.query.findingIds ?? []);
  const docsRefs = new Set<string>();
  const conventionDocsByReference = docsBySnapshotConvention(input.snapshot.conventions);

  const findings = input.snapshot.findings.filter((finding) => {
    const matched =
      findingIds.has(finding.id) ||
      (finding.file ? files.includes(finding.file) : false) ||
      (finding.validatorId ? validatorIds.has(finding.validatorId) : false) ||
      intersects(finding.conventionIds ?? [], [...conventionIds]);
    if (matched) collectFindingContext(finding, { files, validatorIds, conventionIds, docsRefs });
    return matched;
  });

  const validators = selectRelatedValidators(input.snapshot.validators, { files, topics, conventionIds, validatorIds });
  for (const validator of validators) collectValidatorContext(validator, { topics, conventionIds, docsRefs });

  for (const finding of findings) {
    if (finding.validatorId) validatorIds.add(finding.validatorId);
  }

  const validatorsWithFindings = selectRelatedValidators(input.snapshot.validators, { files, topics, conventionIds, validatorIds });
  for (const validator of validatorsWithFindings) collectValidatorContext(validator, { topics, conventionIds, docsRefs });

  const conventions = input.snapshot.conventions.filter(
    (convention) =>
      conventionIds.has(convention.id) ||
      intersects(convention.topics, [...topics]) ||
      intersects(convention.related, [...validatorIds]) ||
      matchesAnyFile(files, convention.applies) ||
      intersects(convention.docs, [...docsRefs]),
  );
  let impactSurfaces = input.snapshot.impactSurfaces.filter(
    (surface) =>
      input.snapshot.conventions.some((convention) => conventionIds.has(convention.id) && convention.impactSurfaces.includes(surface.id)) ||
      intersects(surface.risks ?? [], [...topics]) ||
      intersects(files, surface.applies) ||
      matchesAnyFile(files, surface.applies),
  );
  const impactSurfaceIds = new Set(impactSurfaces.map((surface) => surface.id));
  for (const surface of impactSurfaces) {
    for (const convention of input.snapshot.conventions.filter((item) => item.impactSurfaces.includes(surface.id))) conventionIds.add(convention.id);
    for (const docsRef of surface.docs ?? []) docsRefs.add(docsRef);
    for (const risk of surface.risks ?? []) topics.add(risk);
  }
  for (const convention of conventions) {
    conventionIds.add(convention.id);
    for (const topic of convention.topics) topics.add(topic);
    for (const related of convention.related) {
      if (input.snapshot.validators.some((validator) => validator.id === related)) validatorIds.add(related);
      else conventionIds.add(related);
    }
    for (const docsRef of convention.docs ?? []) docsRefs.add(docsRef);
  }

  const areas = input.snapshot.areas.filter((area) => areaMatchesRelatedContext(area, { files, docsRefs, impactSurfaceIds }));
  const areaIds = new Set(areas.map((area) => area.id));
  for (const area of areas) {
    for (const docsRef of area.docs) docsRefs.add(docsRef);
    for (const surfaceId of area.surfaces) impactSurfaceIds.add(surfaceId);
  }

  const specs = input.snapshot.specs.filter((spec) =>
    specMatchesRelatedContext(spec, {
      files,
      docsRefs,
      conventionIds,
      areaIds,
      impactSurfaceIds,
    }),
  );
  const specIds = new Set(specs.map((spec) => spec.id));
  for (const spec of specs) {
    for (const docsRef of spec.docs) docsRefs.add(docsRef);
    for (const conventionId of spec.governedBy) conventionIds.add(conventionId);
    for (const areaId of spec.areas) areaIds.add(areaId);
    for (const surfaceId of spec.surfaces) impactSurfaceIds.add(surfaceId);
  }

  const changes = input.snapshot.changes.filter((change) =>
    changeMatchesRelatedContext(change, {
      files,
      docsRefs,
      conventionIds,
      areaIds,
      specIds,
      impactSurfaceIds,
    }),
  );
  for (const change of changes) {
    for (const docsRef of change.docs) docsRefs.add(docsRef);
    for (const conventionId of change.updates.conventions) conventionIds.add(conventionId);
    for (const areaId of change.updates.areas) areaIds.add(areaId);
    for (const specId of change.updates.specs) specIds.add(specId);
    for (const surfaceId of change.updates.surfaces) impactSurfaceIds.add(surfaceId);
  }

  impactSurfaces = uniqueById([...impactSurfaces, ...input.snapshot.impactSurfaces.filter((surface) => impactSurfaceIds.has(surface.id))]);

  const finalValidators = selectRelatedValidators(input.snapshot.validators, { files, topics, conventionIds, validatorIds });
  for (const validator of finalValidators) collectValidatorContext(validator, { topics, conventionIds, docsRefs });

  const matchedTopics = unique([
    ...conventions.flatMap((convention) => convention.topics),
    ...finalValidators.flatMap((validator) => validator.topics),
  ]).sort();

  return {
    root: input.rootDir,
    query: {
      files,
      topics: input.query.topics ?? [],
      conventions: input.query.conventionIds ?? [],
      validators: input.query.validatorIds ?? [],
      findings: input.query.findingIds ?? [],
    },
    matchedTopics,
    docs: resolveDocsReferences(input.paths, [...docsRefs], conventionDocsByReference),
    areas,
    specs,
    changes,
    conventions,
    validators: finalValidators.map((validator) => ({
      id: validator.id,
      topics: validator.topics,
      applies: formatAppliesScopes(validator.appliesScopes),
      severity: validator.severity,
      scope: validator.scope,
      domain: validator.domain,
      facts: validator.facts,
      conventionIds: validator.conventionIds,
      docs: validator.docs,
      summary: validator.summary,
    })),
    findings,
    impactSurfaces,
  };
}

export function gitHistorySnapshot(cwd: string, files: string[], limit: number) {
  return getGitFileHistory(cwd, files, limit);
}

export function gitDiffSnapshot(cwd: string, file: string, commit: string) {
  return getGitFileDiff(cwd, file, commit);
}

export function runtimeSnapshotFailure(error: unknown) {
  return createOpenCanonFailure([
    createOpenCanonDiagnostic({
      code: "invalid-runtime-response",
      message: error instanceof Error ? error.message : String(error),
    }),
  ]);
}

function selectRelatedValidators(
  validators: SnapshotValidator[],
  query: { files: string[]; topics: Set<string>; conventionIds: Set<string>; validatorIds: Set<string> },
): SnapshotValidator[] {
  return validators.filter(
    (validator) =>
      query.validatorIds.has(validator.id) ||
      intersects(validator.topics, [...query.topics]) ||
      intersects(validator.conventionIds, [...query.conventionIds]) ||
      validatorMatchesAnyFileMetadata(validator, query.files),
  );
}

function collectFindingContext(
  finding: CanonFinding,
  output: { files: string[]; validatorIds: Set<string>; conventionIds: Set<string>; docsRefs: Set<string> },
): void {
  if (finding.file && !output.files.includes(finding.file)) output.files.push(finding.file);
  if (finding.validatorId) output.validatorIds.add(finding.validatorId);
  for (const conventionId of finding.conventionIds ?? []) output.conventionIds.add(conventionId);
  for (const docsRef of finding.docs ?? []) output.docsRefs.add(docsRef);
}

function collectValidatorContext(
  validator: SnapshotValidator,
  output: { topics: Set<string>; conventionIds: Set<string>; docsRefs: Set<string> },
): void {
  for (const topic of validator.topics) output.topics.add(topic);
  for (const conventionId of validator.conventionIds) output.conventionIds.add(conventionId);
  for (const docsRef of validator.docs) output.docsRefs.add(docsRef);
}

function areaMatchesRelatedContext(
  area: SnapshotArea,
  context: { files: string[]; docsRefs: Set<string>; impactSurfaceIds: Set<string> },
): boolean {
  return (
    matchesAnyFile(context.files, definitionTargetFiles(area.owns)) ||
    intersects(context.files, definitionTargetDocs(area.owns)) ||
    intersects(area.docs, [...context.docsRefs]) ||
    intersects(area.surfaces, [...context.impactSurfaceIds])
  );
}

function specMatchesRelatedContext(
  spec: SnapshotSpec,
  context: {
    files: string[];
    docsRefs: Set<string>;
    conventionIds: Set<string>;
    areaIds: Set<string>;
    impactSurfaceIds: Set<string>;
  },
): boolean {
  return (
    matchesAnyFile(context.files, definitionTargetFiles(spec.scope)) ||
    intersects(context.files, definitionTargetDocs(spec.scope)) ||
    intersects(spec.docs, [...context.docsRefs]) ||
    intersects(spec.governedBy, [...context.conventionIds]) ||
    intersects(spec.areas, [...context.areaIds]) ||
    intersects(spec.surfaces, [...context.impactSurfaceIds])
  );
}

function changeMatchesRelatedContext(
  change: SnapshotChange,
  context: {
    files: string[];
    docsRefs: Set<string>;
    conventionIds: Set<string>;
    areaIds: Set<string>;
    specIds: Set<string>;
    impactSurfaceIds: Set<string>;
  },
): boolean {
  const taskFiles = change.tasks.flatMap((task) => task.files);
  const taskSurfaceIds = unique(change.tasks.flatMap((task) => [...task.surfaces, ...task.updates.surfaces]));
  const taskAreaIds = unique(change.tasks.flatMap((task) => task.updates.areas));
  const taskSpecIds = unique(change.tasks.flatMap((task) => task.updates.specs));
  const taskConventionIds = unique(change.tasks.flatMap((task) => task.updates.conventions));
  const taskDocsRefs = unique(change.tasks.flatMap((task) => task.updates.docs));
  return (
    matchesAnyFile(context.files, definitionTargetFiles(change.scope)) ||
    matchesAnyFile(context.files, taskFiles) ||
    intersects(context.files, definitionTargetDocs(change.scope)) ||
    intersects(change.docs, [...context.docsRefs]) ||
    intersects(taskDocsRefs, [...context.docsRefs]) ||
    intersects(change.updates.conventions, [...context.conventionIds]) ||
    intersects(taskConventionIds, [...context.conventionIds]) ||
    intersects(change.updates.areas, [...context.areaIds]) ||
    intersects(taskAreaIds, [...context.areaIds]) ||
    intersects(change.updates.specs, [...context.specIds]) ||
    intersects(taskSpecIds, [...context.specIds]) ||
    intersects(change.updates.surfaces, [...context.impactSurfaceIds]) ||
    intersects(taskSurfaceIds, [...context.impactSurfaceIds])
  );
}

function validatorMatchesAnyFileMetadata(validator: SnapshotValidator, files: string[]): boolean {
  return files.some((file) => validatorMatchesFileMetadata(validator, file));
}

function validatorMatchesFileMetadata(validator: SnapshotValidator, file: string): boolean {
  return validator.appliesScopes.length === 0 || validator.appliesScopes.every((patterns) => matchesAny(file, patterns));
}

function formatAppliesScopes(scopes: string[][]): string[] {
  if (scopes.length === 0) return ["<project>"];
  if (scopes.length === 1) return scopes[0];
  return [scopes.map((patterns) => patterns.join(", ")).join(" && ")];
}

export function findingSnapshotId(finding: Pick<CanonFinding, "validatorId" | "file" | "line" | "column" | "severity" | "message" | "docs" | "conventionIds">): string {
  const validatorId = finding.validatorId ?? "unknown-validator";
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        validatorId,
        file: finding.file ?? "",
        line: finding.line ?? 0,
        column: finding.column ?? 0,
        severity: finding.severity,
        message: finding.message,
        docs: finding.docs ?? [],
        conventionIds: finding.conventionIds ?? [],
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `${validatorId}:${hash}`;
}
