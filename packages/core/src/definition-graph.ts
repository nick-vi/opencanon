import type { Area, AreaCheck } from "./area.ts";
import type { Change, ChangeCheck } from "./change.ts";
import { ConventionAppliesKind, ConventionDefinitionKind, ConventionRenderKind, type Convention } from "./convention.ts";
import { DefinitionTargetKind, definitionTargetFiles, definitionTargetSummary, type DefinitionTarget } from "./definition-target.ts";
import type { ImpactSurface } from "./context.ts";
import { matchesAnyFile, unique } from "./core-utils.ts";
import { SpecRenderKind, type Spec, type SpecCheck } from "./spec.ts";
import { specDocsReference } from "./spec-render.ts";

export const DefinitionGraphNodeKind = {
  Area: "area",
  Change: "change",
  Check: "check",
  Convention: "convention",
  ImpactSurface: "impact-surface",
  Spec: "spec",
  Task: "task",
  Target: "target",
  Validator: "validator",
} as const;
export type DefinitionGraphNodeKind = (typeof DefinitionGraphNodeKind)[keyof typeof DefinitionGraphNodeKind];

export const DefinitionGraphEdgeKind = {
  Blocks: "blocks",
  Contains: "contains",
  DependsOn: "depends-on",
  Documents: "documents",
  Governs: "governs",
  Owns: "owns",
  Related: "related",
  RequiresCheck: "requires-check",
  Scopes: "scopes",
  Touches: "touches",
  Updates: "updates",
  Validates: "validates",
} as const;
export type DefinitionGraphEdgeKind = (typeof DefinitionGraphEdgeKind)[keyof typeof DefinitionGraphEdgeKind];

export const DefinitionGraphDiagnosticSeverity = {
  Error: "error",
  Warning: "warning",
} as const;
export type DefinitionGraphDiagnosticSeverity = (typeof DefinitionGraphDiagnosticSeverity)[keyof typeof DefinitionGraphDiagnosticSeverity];

const DefinitionCheckKind = {
  Command: "command",
  Test: "test",
  Validator: "validator",
} as const;

export type DefinitionGraphNode = {
  id: string;
  kind: DefinitionGraphNodeKind;
  label: string;
};

export type DefinitionGraphEdge = {
  from: string;
  to: string;
  kind: DefinitionGraphEdgeKind;
  label?: string;
};

export type DefinitionGraphDiagnostic = {
  severity: DefinitionGraphDiagnosticSeverity;
  code: string;
  message: string;
  from?: string;
  to?: string;
};

export type DefinitionGraph = {
  nodes: DefinitionGraphNode[];
  edges: DefinitionGraphEdge[];
  diagnostics: DefinitionGraphDiagnostic[];
  fileCoverage: Record<string, DefinitionGraphFileCoverage>;
  backlinks: {
    areaToSurfaces: Record<string, string[]>;
    specToSurfaces: Record<string, string[]>;
    changeToSurfaces: Record<string, string[]>;
    surfaceToAreas: Record<string, string[]>;
    surfaceToSpecs: Record<string, string[]>;
    surfaceToChanges: Record<string, string[]>;
    surfaceToConventions: Record<string, string[]>;
  };
};

export type DefinitionGraphFileCoverage = {
  areas: string[];
  specs: string[];
  changes: string[];
  conventions: string[];
  surfaces: string[];
};

export type DefinitionGraphInput = {
  areas: Area[];
  specs?: Spec[];
  changes: Change[];
  conventions: Convention[];
  impactSurfaces: ImpactSurface[];
  validators?: Array<{ id: string; conventionIds?: string[] }>;
};

export function buildDefinitionGraph(input: DefinitionGraphInput): DefinitionGraph {
  const nodes = new Map<string, DefinitionGraphNode>();
  const edges: DefinitionGraphEdge[] = [];
  const diagnostics: DefinitionGraphDiagnostic[] = [];
  const areaOwnedTargets = new Map<string, string[]>();
  const checkNodes = new Set<string>();

  const addNode = (node: DefinitionGraphNode) => nodes.set(node.id, node);
  const addEdge = (from: string, to: string, kind: DefinitionGraphEdgeKind, label?: string) => {
    edges.push(label ? { from, to, kind, label } : { from, to, kind });
  };
  const addDiagnostic = (diagnostic: DefinitionGraphDiagnostic) => diagnostics.push(diagnostic);

  const areaIds = new Set(input.areas.map((area) => area.id));
  const specs = input.specs ?? [];
  const specIds = new Set(specs.map((spec) => spec.id));
  const changeIds = new Set(input.changes.map((change) => change.id));
  const conventionIds = new Set(input.conventions.map((convention) => convention.id));
  const surfaceIds = new Set(input.impactSurfaces.map((surface) => surface.id));

  for (const convention of input.conventions) {
    const conventionNode = conventionNodeId(convention.id);
    addNode({ id: conventionNode, kind: DefinitionGraphNodeKind.Convention, label: convention.title || convention.id });
    for (const relatedId of convention.related ?? []) {
      if (conventionIds.has(relatedId)) addEdge(conventionNode, conventionNodeId(relatedId), DefinitionGraphEdgeKind.Related);
    }
    for (const surfaceId of convention.impactSurfaces ?? []) {
      if (surfaceIds.has(surfaceId)) addEdge(conventionNode, surfaceNodeId(surfaceId), DefinitionGraphEdgeKind.Governs);
    }
    if (convention.applies.kind === ConventionAppliesKind.Definitions) {
      for (const target of convention.applies.definitions) {
        const ids = target.ids ?? definitionIdsForKind(target.kind, { specIds, areaIds, changeIds, conventionIds });
        for (const id of ids) {
          const targetNode = definitionNodeIdForKind(target.kind, id);
          addEdge(conventionNode, targetNode, DefinitionGraphEdgeKind.Governs, "applies");
        }
      }
    }
    if (convention.render.kind !== ConventionRenderKind.None) addEdge(conventionNode, targetNodeId(DefinitionTargetKind.Doc, convention.render.docs), DefinitionGraphEdgeKind.Documents);
  }

  for (const validator of input.validators ?? []) {
    const validatorNode = validatorNodeId(validator.id);
    addNode({ id: validatorNode, kind: DefinitionGraphNodeKind.Validator, label: validator.id });
    for (const conventionId of validator.conventionIds ?? []) {
      if (conventionIds.has(conventionId)) addEdge(validatorNode, conventionNodeId(conventionId), DefinitionGraphEdgeKind.Validates);
    }
  }

  for (const surface of input.impactSurfaces) {
    const surfaceNode = surfaceNodeId(surface.id);
    addNode({ id: surfaceNode, kind: DefinitionGraphNodeKind.ImpactSurface, label: surface.title || surface.id });
    for (const conventionId of surface.conventionIds ?? []) {
      if (conventionIds.has(conventionId)) addEdge(surfaceNode, conventionNodeId(conventionId), DefinitionGraphEdgeKind.Governs);
    }
    for (const docsRef of surface.docs ?? []) {
      addEdge(surfaceNode, targetNodeId("doc", docsRef), DefinitionGraphEdgeKind.Documents);
    }
    if (!surface.proposed && surface.applies.length > 0 && (surface.docs ?? []).length === 0) {
      addDiagnostic({
        severity: DefinitionGraphDiagnosticSeverity.Error,
        code: "impact-surface-missing-docs",
        message: `Impact surface ${surface.id} is enforced but has no docs reference.`,
        from: surfaceNode,
      });
    }
  }

  for (const area of input.areas) {
    const areaNode = areaNodeId(area.id);
    addNode({ id: areaNode, kind: DefinitionGraphNodeKind.Area, label: area.title || area.id });
    for (const target of area.owns ?? []) {
      const node = targetNodeFromDefinitionTarget(target);
      addNode(node);
      addEdge(areaNode, node.id, DefinitionGraphEdgeKind.Owns);
      if (!node.id.startsWith("target:doc:")) {
        const owners = areaOwnedTargets.get(node.id) ?? [];
        owners.push(area.id);
        areaOwnedTargets.set(node.id, owners);
      }
    }
    for (const surfaceId of area.surfaces ?? []) {
      if (surfaceIds.has(surfaceId)) addEdge(areaNode, surfaceNodeId(surfaceId), DefinitionGraphEdgeKind.Touches);
    }
    for (const dependencyId of area.dependsOn ?? []) {
      if (areaIds.has(dependencyId)) addEdge(areaNode, areaNodeId(dependencyId), DefinitionGraphEdgeKind.DependsOn);
    }
    for (const conventionId of area.governedBy?.conventions ?? []) {
      if (conventionIds.has(conventionId)) addEdge(areaNode, conventionNodeId(conventionId), DefinitionGraphEdgeKind.Governs);
    }
    addCheckEdges({ ownerNode: areaNode, ownerLabel: `Area ${area.id}`, checks: area.checks ?? [], checkNodes, addNode, addEdge });
    for (const story of area.stories ?? []) addCheckReferenceDiagnostics(`Area ${area.id} story ${story.id}`, story.checks ?? [], area.checks ?? [], areaNode, addDiagnostic);
    for (const behavior of area.behaviors ?? []) addCheckReferenceDiagnostics(`Area ${area.id} behavior ${behavior.id}`, behavior.checks ?? [], area.checks ?? [], areaNode, addDiagnostic);
    if ((area.stories?.length ?? 0) + (area.behaviors?.length ?? 0) > 0 && (area.checks ?? []).length === 0) {
      addDiagnostic({
        severity: DefinitionGraphDiagnosticSeverity.Warning,
        code: "area-missing-checks",
        message: `Area ${area.id} describes behavior but has no checks.`,
        from: areaNode,
      });
    }
  }

  for (const spec of specs) {
    const specNode = specNodeId(spec.id);
    addNode({ id: specNode, kind: DefinitionGraphNodeKind.Spec, label: spec.title || spec.id });
    for (const target of spec.scope ?? []) {
      const node = targetNodeFromDefinitionTarget(target);
      addNode(node);
      addEdge(specNode, node.id, DefinitionGraphEdgeKind.Scopes);
    }
    for (const surfaceId of spec.surfaces ?? []) {
      if (surfaceIds.has(surfaceId)) addEdge(specNode, surfaceNodeId(surfaceId), DefinitionGraphEdgeKind.Touches);
    }
    for (const areaId of spec.areas ?? []) {
      if (areaIds.has(areaId)) addEdge(specNode, areaNodeId(areaId), DefinitionGraphEdgeKind.Related, "area");
    }
    for (const dependencyId of spec.dependsOn ?? []) {
      if (specIds.has(dependencyId)) addEdge(specNode, specNodeId(dependencyId), DefinitionGraphEdgeKind.DependsOn);
    }
    for (const conventionId of spec.governedBy?.conventions ?? []) {
      if (conventionIds.has(conventionId)) addEdge(specNode, conventionNodeId(conventionId), DefinitionGraphEdgeKind.Governs);
    }
    if (spec.render.kind !== SpecRenderKind.None) {
      const docsRef = specDocsReference(spec);
      if (docsRef) addEdge(specNode, targetNodeId(DefinitionTargetKind.Doc, docsRef), DefinitionGraphEdgeKind.Documents);
    }
    addCheckEdges({ ownerNode: specNode, ownerLabel: `Spec ${spec.id}`, checks: spec.checks ?? [], checkNodes, addNode, addEdge });
    for (const rule of spec.rules ?? []) addCheckReferenceDiagnostics(`Spec ${spec.id} rule ${rule.id}`, rule.checks ?? [], spec.checks ?? [], specNode, addDiagnostic);
    for (const scenario of spec.scenarios ?? []) addCheckReferenceDiagnostics(`Spec ${spec.id} scenario ${scenario.id}`, scenario.checks ?? [], spec.checks ?? [], specNode, addDiagnostic);
    if ((spec.rules?.length ?? 0) + (spec.scenarios?.length ?? 0) > 0 && (spec.checks ?? []).length === 0) {
      addDiagnostic({
        severity: DefinitionGraphDiagnosticSeverity.Warning,
        code: "spec-missing-checks",
        message: `Spec ${spec.id} describes behavior but has no checks.`,
        from: specNode,
      });
    }
  }

  for (const change of input.changes) {
    const changeNode = changeNodeId(change.id);
    addNode({ id: changeNode, kind: DefinitionGraphNodeKind.Change, label: change.title || change.id });
    for (const target of change.scope ?? []) {
      const node = targetNodeFromDefinitionTarget(target);
      addNode(node);
      addEdge(changeNode, node.id, DefinitionGraphEdgeKind.Scopes);
    }
    for (const areaId of change.updates?.areas ?? []) {
      if (areaIds.has(areaId)) addEdge(changeNode, areaNodeId(areaId), DefinitionGraphEdgeKind.Updates);
    }
    for (const specId of change.updates?.specs ?? []) {
      if (specIds.has(specId)) addEdge(changeNode, specNodeId(specId), DefinitionGraphEdgeKind.Updates);
    }
    for (const conventionId of change.updates?.conventions ?? []) {
      if (conventionIds.has(conventionId)) addEdge(changeNode, conventionNodeId(conventionId), DefinitionGraphEdgeKind.Updates);
    }
    for (const surfaceId of change.updates?.surfaces ?? []) {
      if (surfaceIds.has(surfaceId)) addEdge(changeNode, surfaceNodeId(surfaceId), DefinitionGraphEdgeKind.Touches);
    }
    for (const dependencyId of change.dependsOn ?? []) {
      if (changeIds.has(dependencyId)) addEdge(changeNode, changeNodeId(dependencyId), DefinitionGraphEdgeKind.DependsOn);
    }
    for (const blockerId of change.blockedBy ?? []) {
      if (changeIds.has(blockerId)) addEdge(changeNode, changeNodeId(blockerId), DefinitionGraphEdgeKind.Blocks);
    }
    addCheckEdges({ ownerNode: changeNode, ownerLabel: `Change ${change.id}`, checks: change.checks ?? [], checkNodes, addNode, addEdge });
    for (const plan of change.plan ?? []) addCheckReferenceDiagnostics(`Change ${change.id} plan ${plan.id}`, plan.checks ?? [], change.checks ?? [], changeNode, addDiagnostic);
    addChangeTaskEdges({ change, changeNode, areaIds, specIds, conventionIds, surfaceIds, checkNodes, addNode, addEdge, addDiagnostic });
    if ((change.plan?.length ?? 0) + (change.tasks?.length ?? 0) > 0 && (change.checks ?? []).length === 0) {
      addDiagnostic({
        severity: DefinitionGraphDiagnosticSeverity.Warning,
        code: "change-missing-checks",
        message: `Change ${change.id} has plan/task entries but no checks.`,
        from: changeNode,
      });
    }
  }

  for (const [targetId, owners] of areaOwnedTargets.entries()) {
    const uniqueOwners = unique(owners);
    if (uniqueOwners.length > 1) {
      addDiagnostic({
        severity: DefinitionGraphDiagnosticSeverity.Error,
        code: "duplicate-area-ownership",
        message: `Definition target ${targetId.replace(/^target:/, "")} is owned by multiple areas: ${uniqueOwners.join(", ")}.`,
        to: targetId,
      });
    }
  }

  const backlinks = deriveBacklinks(input, addEdge, addDiagnostic);
  for (const edge of edges) {
    if (!nodes.has(edge.to) && edge.to.startsWith("target:")) addNode({ id: edge.to, kind: DefinitionGraphNodeKind.Target, label: edge.to.replace(/^target:[^:]+:/, "") });
  }

  return { nodes: [...nodes.values()].sort(byId), edges: uniqueEdges(edges).sort(byEdge), diagnostics, fileCoverage: {}, backlinks };
}

function addChangeTaskEdges(input: {
  change: Change;
  changeNode: string;
  areaIds: Set<string>;
  specIds: Set<string>;
  conventionIds: Set<string>;
  surfaceIds: Set<string>;
  checkNodes: Set<string>;
  addNode: (node: DefinitionGraphNode) => void;
  addEdge: (from: string, to: string, kind: DefinitionGraphEdgeKind, label?: string) => void;
  addDiagnostic: (diagnostic: DefinitionGraphDiagnostic) => void;
}): void {
  const taskIds = new Set((input.change.tasks ?? []).map((task) => task.id));
  for (const task of input.change.tasks ?? []) {
    const taskNode = taskNodeId(input.change.id, task.id);
    input.addNode({ id: taskNode, kind: DefinitionGraphNodeKind.Task, label: task.title || task.id });
    input.addEdge(input.changeNode, taskNode, DefinitionGraphEdgeKind.Contains);

    for (const file of task.files ?? []) {
      const targetNode = targetNodeId(DefinitionTargetKind.File, file);
      input.addNode({ id: targetNode, kind: DefinitionGraphNodeKind.Target, label: file });
      input.addEdge(taskNode, targetNode, DefinitionGraphEdgeKind.Scopes);
    }
    for (const surfaceId of task.surfaces ?? []) {
      if (input.surfaceIds.has(surfaceId)) input.addEdge(taskNode, surfaceNodeId(surfaceId), DefinitionGraphEdgeKind.Touches);
    }
    for (const dependencyId of task.dependsOn ?? []) {
      if (taskIds.has(dependencyId)) input.addEdge(taskNode, taskNodeId(input.change.id, dependencyId), DefinitionGraphEdgeKind.DependsOn);
      else input.addDiagnostic({
        severity: DefinitionGraphDiagnosticSeverity.Error,
        code: "change-task-missing-dependency",
        message: `Change ${input.change.id} task ${task.id} references missing task ${dependencyId}.`,
        from: taskNode,
      });
    }
    for (const blockerId of task.blockedBy ?? []) {
      if (taskIds.has(blockerId)) input.addEdge(taskNode, taskNodeId(input.change.id, blockerId), DefinitionGraphEdgeKind.Blocks);
      else input.addDiagnostic({
        severity: DefinitionGraphDiagnosticSeverity.Error,
        code: "change-task-missing-blocker",
        message: `Change ${input.change.id} task ${task.id} references missing blocking task ${blockerId}.`,
        from: taskNode,
      });
    }

    for (const areaId of task.updates?.areas ?? []) {
      if (input.areaIds.has(areaId)) input.addEdge(taskNode, areaNodeId(areaId), DefinitionGraphEdgeKind.Updates);
    }
    for (const specId of task.updates?.specs ?? []) {
      if (input.specIds.has(specId)) input.addEdge(taskNode, specNodeId(specId), DefinitionGraphEdgeKind.Updates);
    }
    for (const conventionId of task.updates?.conventions ?? []) {
      if (input.conventionIds.has(conventionId)) input.addEdge(taskNode, conventionNodeId(conventionId), DefinitionGraphEdgeKind.Updates);
    }
    for (const surfaceId of task.updates?.surfaces ?? []) {
      if (input.surfaceIds.has(surfaceId)) input.addEdge(taskNode, surfaceNodeId(surfaceId), DefinitionGraphEdgeKind.Touches);
    }

    addCheckReferenceDiagnostics(`Change ${input.change.id} task ${task.id}`, task.checks ?? [], input.change.checks ?? [], taskNode, input.addDiagnostic);
    addCheckEdges({
      ownerNode: taskNode,
      ownerLabel: `Change ${input.change.id} task ${task.id}`,
      checks: (input.change.checks ?? []).filter((check) => (task.checks ?? []).includes(check.id)),
      checkNodes: input.checkNodes,
      addNode: input.addNode,
      addEdge: input.addEdge,
    });
  }
}

function deriveBacklinks(
  input: DefinitionGraphInput,
  addEdge: (from: string, to: string, kind: DefinitionGraphEdgeKind, label?: string) => void,
  addDiagnostic: (diagnostic: DefinitionGraphDiagnostic) => void,
): DefinitionGraph["backlinks"] {
  const areaToSurfaces: Record<string, string[]> = {};
  const specToSurfaces: Record<string, string[]> = {};
  const changeToSurfaces: Record<string, string[]> = {};
  const surfaceToAreas: Record<string, string[]> = {};
  const surfaceToSpecs: Record<string, string[]> = {};
  const surfaceToChanges: Record<string, string[]> = {};
  const surfaceToConventions: Record<string, string[]> = {};
  const specs = input.specs ?? [];

  for (const surface of input.impactSurfaces) {
    const conventionIds = unique(
      input.conventions
        .filter((convention) => (convention.impactSurfaces ?? []).includes(surface.id) || (surface.conventionIds ?? []).includes(convention.id))
        .map((convention) => convention.id),
    );
    surfaceToConventions[surface.id] = conventionIds;

    const areaIds = unique(input.areas.filter((area) => areaTouchesSurface(area, surface)).map((area) => area.id));
    surfaceToAreas[surface.id] = areaIds;
    for (const areaId of areaIds) {
      areaToSurfaces[areaId] = unique([...(areaToSurfaces[areaId] ?? []), surface.id]);
      addEdge(areaNodeId(areaId), surfaceNodeId(surface.id), DefinitionGraphEdgeKind.Touches, "derived");
    }

    const specIds = unique(specs.filter((spec) => specTouchesSurface(spec, surface)).map((spec) => spec.id));
    surfaceToSpecs[surface.id] = specIds;
    for (const specId of specIds) {
      specToSurfaces[specId] = unique([...(specToSurfaces[specId] ?? []), surface.id]);
      addEdge(specNodeId(specId), surfaceNodeId(surface.id), DefinitionGraphEdgeKind.Touches, "derived");
    }

    const changeIds = unique(input.changes.filter((change) => changeTouchesSurface(change, surface)).map((change) => change.id));
    surfaceToChanges[surface.id] = changeIds;
    for (const changeId of changeIds) {
      changeToSurfaces[changeId] = unique([...(changeToSurfaces[changeId] ?? []), surface.id]);
      addEdge(changeNodeId(changeId), surfaceNodeId(surface.id), DefinitionGraphEdgeKind.Touches, "derived");
    }

    if (!surface.proposed && areaIds.length === 0 && specIds.length === 0) {
      addDiagnostic({
        severity: DefinitionGraphDiagnosticSeverity.Warning,
        code: "impact-surface-without-area",
        message: `Impact surface ${surface.id} has no area or spec backlink.`,
        from: surfaceNodeId(surface.id),
      });
    }
  }

  for (const area of input.areas) {
    const declared = new Set(area.surfaces ?? []);
    for (const surfaceId of areaToSurfaces[area.id] ?? []) {
      if (!declared.has(surfaceId)) {
        addDiagnostic({
          severity: DefinitionGraphDiagnosticSeverity.Warning,
          code: "area-implicit-impact-surface",
          message: `Area ${area.id} owns files in impact surface ${surfaceId} but does not list it in surfaces.`,
          from: areaNodeId(area.id),
          to: surfaceNodeId(surfaceId),
        });
      }
    }
  }

  for (const change of input.changes) {
    const declared = new Set([
      ...(change.updates?.surfaces ?? []),
      ...(change.tasks ?? []).flatMap((task) => [...(task.surfaces ?? []), ...(task.updates?.surfaces ?? [])]),
    ]);
    for (const surfaceId of changeToSurfaces[change.id] ?? []) {
      if (!declared.has(surfaceId)) {
        addDiagnostic({
          severity: DefinitionGraphDiagnosticSeverity.Warning,
          code: "change-implicit-impact-surface",
          message: `Change ${change.id} scopes files in impact surface ${surfaceId} but does not list it in updates.surfaces.`,
          from: changeNodeId(change.id),
          to: surfaceNodeId(surfaceId),
        });
      }
    }
  }

  for (const spec of specs) {
    const declared = new Set(spec.surfaces ?? []);
    for (const surfaceId of specToSurfaces[spec.id] ?? []) {
      if (!declared.has(surfaceId)) {
        addDiagnostic({
          severity: DefinitionGraphDiagnosticSeverity.Warning,
          code: "spec-implicit-impact-surface",
          message: `Spec ${spec.id} scopes files in impact surface ${surfaceId} but does not list it in surfaces.`,
          from: specNodeId(spec.id),
          to: surfaceNodeId(surfaceId),
        });
      }
    }
  }

  return { areaToSurfaces, specToSurfaces, changeToSurfaces, surfaceToAreas, surfaceToSpecs, surfaceToChanges, surfaceToConventions };
}

function areaTouchesSurface(area: Area, surface: ImpactSurface): boolean {
  return (area.surfaces ?? []).includes(surface.id) || matchesAnyFile(definitionTargetFiles(area.owns), surface.applies);
}

function specTouchesSurface(spec: Spec, surface: ImpactSurface): boolean {
  return (spec.surfaces ?? []).includes(surface.id) || matchesAnyFile(definitionTargetFiles(spec.scope), surface.applies);
}

function changeTouchesSurface(change: Change, surface: ImpactSurface): boolean {
  return (
    (change.updates?.surfaces ?? []).includes(surface.id) ||
    (change.tasks ?? []).some((task) => (task.surfaces ?? []).includes(surface.id) || (task.updates?.surfaces ?? []).includes(surface.id) || matchesAnyFile(task.files ?? [], surface.applies)) ||
    matchesAnyFile(definitionTargetFiles(change.scope), surface.applies)
  );
}

function addCheckEdges(input: {
  ownerNode: string;
  ownerLabel: string;
  checks: Array<AreaCheck | SpecCheck | ChangeCheck>;
  checkNodes: Set<string>;
  addNode(node: DefinitionGraphNode): void;
  addEdge(from: string, to: string, kind: DefinitionGraphEdgeKind, label?: string): void;
}): void {
  for (const check of input.checks) {
    const checkNode = checkNodeId(input.ownerNode, check.id);
    if (!input.checkNodes.has(checkNode)) {
      input.addNode({ id: checkNode, kind: DefinitionGraphNodeKind.Check, label: `${input.ownerLabel} check ${check.id}` });
      input.checkNodes.add(checkNode);
    }
    input.addEdge(input.ownerNode, checkNode, DefinitionGraphEdgeKind.RequiresCheck, check.kind);
    if (check.kind === DefinitionCheckKind.Validator) input.addEdge(checkNode, validatorNodeId(check.validatorId), DefinitionGraphEdgeKind.Validates);
    if (check.kind === DefinitionCheckKind.Test) input.addEdge(checkNode, targetNodeId(DefinitionTargetKind.File, check.target), DefinitionGraphEdgeKind.Validates);
    if (check.kind === DefinitionCheckKind.Command) input.addEdge(checkNode, targetNodeId(DefinitionTargetKind.Command, check.command), DefinitionGraphEdgeKind.Validates);
  }
}

function addCheckReferenceDiagnostics(
  label: string,
  checkIds: string[],
  checks: Array<{ id: string }>,
  from: string,
  addDiagnostic: (diagnostic: DefinitionGraphDiagnostic) => void,
): void {
  const known = new Set(checks.map((check) => check.id));
  for (const checkId of checkIds) {
    if (!known.has(checkId)) {
      addDiagnostic({
        severity: DefinitionGraphDiagnosticSeverity.Error,
        code: "missing-check-reference",
        message: `${label} references missing check: ${checkId}.`,
        from,
      });
    }
  }
}

function targetNodeFromDefinitionTarget(target: DefinitionTarget): DefinitionGraphNode {
  const id = targetNodeId(target.kind, definitionTargetSummary(target));
  return { id, kind: DefinitionGraphNodeKind.Target, label: definitionTargetSummary(target) };
}

function definitionIdsForKind(
  kind: ConventionDefinitionKind,
  input: { specIds: Set<string>; areaIds: Set<string>; changeIds: Set<string>; conventionIds: Set<string> },
): string[] {
  switch (kind) {
    case ConventionDefinitionKind.Spec:
      return [...input.specIds];
    case ConventionDefinitionKind.Area:
      return [...input.areaIds];
    case ConventionDefinitionKind.Change:
      return [...input.changeIds];
    case ConventionDefinitionKind.Convention:
      return [...input.conventionIds];
  }
}

function definitionNodeIdForKind(kind: ConventionDefinitionKind, id: string): string {
  switch (kind) {
    case ConventionDefinitionKind.Spec:
      return specNodeId(id);
    case ConventionDefinitionKind.Area:
      return areaNodeId(id);
    case ConventionDefinitionKind.Change:
      return changeNodeId(id);
    case ConventionDefinitionKind.Convention:
      return conventionNodeId(id);
  }
}

function targetNodeId(kind: string, value: string): string {
  return `target:${kind}:${value}`;
}

function areaNodeId(id: string): string {
  return `area:${id}`;
}

function changeNodeId(id: string): string {
  return `change:${id}`;
}

function taskNodeId(changeId: string, taskId: string): string {
  return `change:${changeId}:task:${taskId}`;
}

function specNodeId(id: string): string {
  return `spec:${id}`;
}

function conventionNodeId(id: string): string {
  return `convention:${id}`;
}

function surfaceNodeId(id: string): string {
  return `impact-surface:${id}`;
}

function validatorNodeId(id: string): string {
  return `validator:${id}`;
}

function checkNodeId(ownerNode: string, id: string): string {
  return `${ownerNode}:check:${id}`;
}

function uniqueEdges(edges: DefinitionGraphEdge[]): DefinitionGraphEdge[] {
  const seen = new Set<string>();
  const result: DefinitionGraphEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}\0${edge.kind}\0${edge.to}\0${edge.label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result;
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

function byEdge(left: DefinitionGraphEdge, right: DefinitionGraphEdge): number {
  return `${left.from}:${left.kind}:${left.to}:${left.label ?? ""}`.localeCompare(`${right.from}:${right.kind}:${right.to}:${right.label ?? ""}`);
}
