import { createHash } from "node:crypto";
import {
  AreaRenderKind,
  ChangeRenderKind,
  ChangeWorkStatus,
  ConventionRenderKind,
  areaDocsReference,
  changeDocsReference,
  conventionDocsReference,
  definitionTargetDocs,
  definitionTargetFiles,
  deriveChangeTaskStates,
  matchesAny,
  matchesAnyFile,
  relative,
  specDocsReference,
  type Area,
  type CanonEvent,
  type CanonFinding,
  type Change,
  type Convention,
  type DefinitionGraph,
  type DefinitionGraphFileCoverage,
  type ImpactSurface,
  type ProductModelProjection,
  type Spec,
} from "@opencanon/core";
import type { activeTaskLeaseSummaries } from "./worktree-coordination.ts";
import type { SnapshotArea, SnapshotChange, SnapshotChangeBoardColumn, SnapshotChangeTask, SnapshotConvention, SnapshotImpactSurface, SnapshotSpec, SnapshotValidator } from "./snapshot.ts";

const FindingSeverity = {
  Error: "error",
} as const;

export function buildProductModelProjection(input: {
  areas: SnapshotArea[];
  specs: SnapshotSpec[];
  changes: SnapshotChange[];
  conventions: SnapshotConvention[];
  impactSurfaces: SnapshotImpactSurface[];
  validators: SnapshotValidator[];
  definitionGraph: DefinitionGraph;
}): ProductModelProjection {
  const definitions = {
    areas: input.areas,
    specs: input.specs,
    changes: input.changes,
    conventions: input.conventions,
    impactSurfaces: input.impactSurfaces,
    validators: input.validators,
  };
  return {
    indexedAt: new Date().toISOString(),
    graphHash: stableJsonHash(input.definitionGraph),
    definitionsHash: stableJsonHash(definitions),
    counts: {
      areas: input.areas.length,
      specs: input.specs.length,
      changes: input.changes.length,
      conventions: input.conventions.length,
      impactSurfaces: input.impactSurfaces.length,
      validators: input.validators.length,
      nodes: input.definitionGraph.nodes.length,
      edges: input.definitionGraph.edges.length,
      diagnostics: input.definitionGraph.diagnostics.length,
    },
    ...definitions,
    definitionGraph: input.definitionGraph,
  };
}

function stableJsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

export function conventionsByValidator(conventions: Convention[]): Map<string, string[]> {
  const byValidator = new Map<string, string[]>();
  for (const convention of conventions) {
    for (const validatorId of convention.related ?? []) {
      const values = byValidator.get(validatorId) ?? [];
      values.push(convention.id);
      byValidator.set(validatorId, values);
    }
  }
  return byValidator;
}

export function docsByConvention(conventions: Convention[]): Map<string, string[]> {
  const byReference = new Map<string, string[]>();
  for (const convention of conventions) {
    if (convention.render.kind === ConventionRenderKind.None) continue;
    const docsRef = conventionDocsReference(convention)!;
    const values = byReference.get(docsRef) ?? [];
    values.push(convention.id);
    byReference.set(docsRef, values);
  }
  return byReference;
}

export function docsBySnapshotConvention(conventions: SnapshotConvention[]): Map<string, string[]> {
  const byReference = new Map<string, string[]>();
  for (const convention of conventions) {
    for (const docsRef of convention.docs) {
      const values = byReference.get(docsRef) ?? [];
      values.push(convention.id);
      byReference.set(docsRef, values);
    }
  }
  return byReference;
}

export function snapshotArea(rootDir: string, areasPath: string, area: Area): SnapshotArea {
  return {
    id: area.id,
    title: area.title,
    summary: area.summary,
    surfaces: area.surfaces ?? [],
    owns: area.owns ?? [],
    storyCount: area.stories?.length ?? 0,
    behaviorCount: area.behaviors?.length ?? 0,
    checks: (area.checks ?? []).map((check) => ({ id: check.id, kind: check.kind })),
    dependsOn: area.dependsOn ?? [],
    docs: area.render.kind === AreaRenderKind.None ? [] : [areaDocsReference(area)!],
    render: area.render.kind,
    source: `${relative(rootDir, areasPath)}#${area.id}`,
  };
}

export function snapshotSpec(rootDir: string, specsPath: string, spec: Spec): SnapshotSpec {
  return {
    id: spec.id,
    title: spec.title,
    summary: spec.summary,
    surfaces: spec.surfaces ?? [],
    areas: spec.areas ?? [],
    scope: spec.scope ?? [],
    ruleCount: spec.rules?.length ?? 0,
    scenarioCount: spec.scenarios?.length ?? 0,
    checks: (spec.checks ?? []).map((check) => ({ id: check.id, kind: check.kind })),
    dependsOn: spec.dependsOn ?? [],
    governedBy: spec.governedBy?.conventions ?? [],
    docs: spec.render.kind === "none" ? [] : [specDocsReference(spec)!],
    render: spec.render.kind,
    source: `${relative(rootDir, specsPath)}#${spec.id}`,
  };
}

export function snapshotChange(rootDir: string, changesPath: string, change: Change, state: { events: CanonEvent[]; findings: CanonFinding[]; taskLeases: ReturnType<typeof activeTaskLeaseSummaries> }): SnapshotChange {
  const lastEvent = latestChangeEvent(change.id, state.events);
  const lastChangeLevelEvent = latestChangeLevelEvent(change.id, state.events);
  const tasks = deriveChangeTaskStates(change, state.events, { leases: state.taskLeases }).map((task): SnapshotChangeTask => ({
    ...task,
    updates: {
      areas: task.updates.areas ?? [],
      specs: task.updates.specs ?? [],
      conventions: task.updates.conventions ?? [],
      surfaces: task.updates.surfaces ?? [],
      docs: task.updates.docs ?? [],
    },
  }));
  return {
    id: change.id,
    title: change.title,
    kind: change.kind,
    summary: change.summary ?? change.intent.outcome,
    intent: change.intent,
    updates: {
      areas: change.updates?.areas ?? [],
      specs: change.updates?.specs ?? [],
      conventions: change.updates?.conventions ?? [],
      surfaces: change.updates?.surfaces ?? [],
      docs: change.updates?.docs ?? [],
    },
    scope: change.scope ?? [],
    planCount: change.plan?.length ?? 0,
    taskCount: change.tasks?.length ?? 0,
    readyTaskCount: tasks.filter((task) => task.ready).length,
    blockedTaskCount: tasks.filter((task) => task.status === ChangeWorkStatus.Blocked || task.blockedReasons.length > 0).length,
    tasks,
    checks: (change.checks ?? []).map((check) => ({ id: check.id, kind: check.kind })),
    dependsOn: change.dependsOn ?? [],
    blockedBy: change.blockedBy ?? [],
    docs: change.render.kind === ChangeRenderKind.None ? [] : [changeDocsReference(change)!],
    render: change.render.kind,
    source: `${relative(rootDir, changesPath)}#${change.id}`,
    boardColumn: changeBoardColumn(change, { lastEvent: lastChangeLevelEvent, findings: state.findings, tasks }),
    lastEvent: lastEvent ? { type: lastEvent.type, timestamp: lastEvent.timestamp, summary: lastEvent.summary } : undefined,
  };
}

function latestChangeEvent(changeId: string, events: CanonEvent[]): CanonEvent | undefined {
  return events
    .filter((event) => (event.changeIds ?? []).includes(changeId))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
}

function latestChangeLevelEvent(changeId: string, events: CanonEvent[]): CanonEvent | undefined {
  return events
    .filter((event) => (event.changeIds ?? []).includes(changeId) && !isTaskScopedChangeEvent(event))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
}

function isTaskScopedChangeEvent(event: CanonEvent): boolean {
  return (event.taskIds?.length ?? 0) > 0 || event.type.startsWith("task-");
}

function changeBoardColumn(change: Change, state: { lastEvent?: CanonEvent; findings: CanonFinding[]; tasks: SnapshotChangeTask[] }): SnapshotChangeBoardColumn {
  const eventColumn = state.lastEvent ? changeBoardColumnFromEvent(state.lastEvent) : undefined;
  if (eventColumn === "closed" || eventColumn === "ready" || eventColumn === "review" || eventColumn === "running") return eventColumn;
  if (changeHasBlockingFindings(change, state.findings)) return "blocked";
  if (eventColumn === "blocked") return "blocked";
  if (state.tasks.length > 0) {
    if (state.tasks.some((task) => task.status === ChangeWorkStatus.Blocked || task.blockedReasons.length > 0)) return "blocked";
    if (state.tasks.some((task) => task.status === ChangeWorkStatus.Running || task.status === ChangeWorkStatus.Claimed)) return "running";
    if (state.tasks.some((task) => task.status === ChangeWorkStatus.Review)) return "review";
    if (state.tasks.every((task) => task.status === ChangeWorkStatus.Closed) || state.tasks.some((task) => task.ready || task.status === ChangeWorkStatus.Ready)) return "ready";
  }
  return "planned";
}

function changeBoardColumnFromEvent(event: CanonEvent): SnapshotChangeBoardColumn | undefined {
  switch (event.type) {
    case "change-started":
    case "check-started":
      return "running";
    case "change-review":
      return "review";
    case "change-blocked":
    case "check-failed":
      return "blocked";
    case "change-ready":
    case "check-passed":
      return "ready";
    case "change-closed":
      return "closed";
    default:
      return undefined;
  }
}

function changeHasBlockingFindings(change: Change, findings: CanonFinding[]): boolean {
  const files = definitionTargetFiles(change.scope);
  if (files.length === 0) return false;
  return findings.some((finding) => finding.severity === FindingSeverity.Error && finding.file && (files.includes(finding.file) || matchesAnyFile([finding.file], files)));
}

export function snapshotImpactSurfaces(surfaces: ImpactSurface[], areas: Area[], specs: Spec[], changes: Change[]): SnapshotImpactSurface[] {
  return surfaces.map((surface) => ({
    ...surface,
    areaIds: areas
      .filter((area) => areaLinksImpactSurface(area, surface))
      .map((area) => area.id)
      .sort(),
    specIds: specs
      .filter((spec) => specLinksImpactSurface(spec, surface))
      .map((spec) => spec.id)
      .sort(),
    changeIds: changes
      .filter((change) => changeLinksImpactSurface(change, surface))
      .map((change) => change.id)
      .sort(),
  }));
}

function areaLinksImpactSurface(area: Area, surface: ImpactSurface): boolean {
  if ((area.surfaces ?? []).includes(surface.id)) return true;
  return filesTouchImpactSurface(definitionTargetFiles(area.owns), surface);
}

function specLinksImpactSurface(spec: Spec, surface: ImpactSurface): boolean {
  if ((spec.surfaces ?? []).includes(surface.id)) return true;
  return filesTouchImpactSurface(definitionTargetFiles(spec.scope), surface);
}

function changeLinksImpactSurface(change: Change, surface: ImpactSurface): boolean {
  if ((change.updates?.surfaces ?? []).includes(surface.id)) return true;
  return filesTouchImpactSurface(definitionTargetFiles(change.scope), surface);
}

function filesTouchImpactSurface(files: string[], surface: ImpactSurface): boolean {
  if (files.length === 0) return false;
  return files.some((file) => surface.applies.includes(file) || matchesAnyFile([file], surface.applies));
}

export function buildSnapshotFileCoverage(input: {
  files: string[];
  areas: SnapshotArea[];
  specs: SnapshotSpec[];
  changes: SnapshotChange[];
  conventions: SnapshotConvention[];
  impactSurfaces: SnapshotImpactSurface[];
}): Record<string, DefinitionGraphFileCoverage> {
  const coverage: Record<string, DefinitionGraphFileCoverage> = {};
  for (const file of input.files) {
    coverage[file] = {
      areas: input.areas
        .filter((area) => fileMatchesReferences(file, [...definitionTargetFiles(area.owns), ...area.docs]))
        .map((area) => area.id),
      specs: input.specs
        .filter((spec) => fileMatchesReferences(file, [...definitionTargetFiles(spec.scope), ...spec.docs]))
        .map((spec) => spec.id),
      changes: input.changes
        .filter((change) => fileMatchesReferences(file, [...definitionTargetFiles(change.scope), ...change.docs, ...change.updates.docs]))
        .map((change) => change.id),
      conventions: input.conventions
        .filter((convention) => fileMatchesReferences(file, [...convention.applies, ...convention.docs]))
        .map((convention) => convention.id),
      surfaces: input.impactSurfaces
        .filter((surface) => fileMatchesReferences(file, [...surface.applies, ...(surface.owns ?? []), ...(surface.docs ?? [])]))
        .map((surface) => surface.id),
    };
  }
  return coverage;
}

function fileMatchesReferences(file: string, references: string[]): boolean {
  const patterns = references.map(stripReferenceHash).filter((reference) => reference.length > 0);
  return patterns.length > 0 && matchesAny(file, patterns);
}

function stripReferenceHash(value: string): string {
  return value.split("#", 1)[0] ?? "";
}

export function snapshotConvention(rootDir: string, conventionsPath: string, convention: Convention): SnapshotConvention {
  return {
    id: convention.id,
    title: convention.title,
    topics: convention.topics ?? [],
    applies: conventionApplies(convention),
    rule: convention.rule,
    why: convention.why,
    related: convention.related ?? [],
    impactSurfaces: convention.impactSurfaces ?? [],
    docs: convention.render.kind === ConventionRenderKind.None ? [] : [conventionDocsReference(convention)!],
    runtime: convention.runtime.kind,
    render: convention.render.kind,
    source: `${relative(rootDir, conventionsPath)}#${convention.id}`,
  };
}

function conventionApplies(convention: Convention): string[] {
  switch (convention.applies.kind) {
    case "files":
    case "symbols":
      return convention.applies.globs;
    case "imports":
      return [...(convention.applies.from ?? []), ...(convention.applies.to ?? [])];
    case "impact-surface":
      return convention.applies.surfaceIds;
    case "definitions":
      return convention.applies.definitions.flatMap((target) => (target.ids ?? ["*"]).map((id) => `${target.kind}:${id}`));
    case "project":
      return [convention.applies.describe ?? "project"];
    case "custom":
      return [convention.applies.describe];
  }
}
