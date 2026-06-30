export type {
  Baseline,
  ChangePolicy,
  ContextConfig,
  ContextDiagnostic,
  ContextPaths,
  ContextReferenceValidator,
  ContextValidationInput,
  ImpactSurface,
  ProposedImpactNote,
} from "./context.ts";
export type { Area, AreaBehavior, AreaCheck, AreaGovernance, AreaId, AreaOwnership, AreaRender, AreaResolution, AreaStory } from "./area.ts";
export { AreaCheckKind, AreaRenderKind, AreaRenderStyle, defineArea, resolveAreas } from "./area.ts";
export {
  areaAnchor,
  areaDocsReference,
  renderArea,
  resolveAreaGeneratedDocsPath,
  validateGeneratedAreaDocsPath,
} from "./area-render.ts";
export type { Spec, SpecCheck, SpecGovernance, SpecId, SpecRender, SpecResolution, SpecRule, SpecScenario, SpecScope } from "./spec.ts";
export { SpecCheckKind, SpecRenderKind, SpecRenderStyle, defineSpec, resolveSpecs } from "./spec.ts";
export {
  renderSpec,
  resolveSpecGeneratedDocsPath,
  specAnchor,
  specDocsReference,
  validateGeneratedSpecDocsPath,
} from "./spec-render.ts";
export type { Change, ChangeCheck, ChangeId, ChangeIntent, ChangeLinks, ChangePlanItem, ChangeRender, ChangeResolution, ChangeScope, ChangeTask, ChangeUpdates } from "./change.ts";
export { ChangeCheckKind, ChangeKind, ChangeRenderKind, ChangeRenderStyle, defineChange, resolveChanges } from "./change.ts";
export {
  ChangeCheckEventType,
  ChangeCheckStatus,
  ChangeLifecycleEventType,
  ChangeTaskEventType,
  ChangeWorkStatus,
  deriveChangeTaskStates,
  deriveChangeWorkQueue,
  deriveChangeWorkStatus,
  latestChangeEvent,
} from "./change-state.ts";
export type { ChangeBlockedWorkItem, ChangeCheckState, ChangeEventSummary, ChangeReadyWorkItem, ChangeTaskState, ChangeWorkQueue } from "./change-state.ts";
export {
  changeAnchor,
  changeDocsReference,
  renderChange,
  resolveChangeGeneratedDocsPath,
  validateGeneratedChangeDocsPath,
} from "./change-render.ts";
export {
  createDefaultConfig,
  createPaths,
  loadBaseline,
  loadConfig,
  loadImpactSurfaces,
  loadProposedImpactNotes,
  ProjectFileName,
  resolveRootDir,
  validateConfig,
  validateContext,
  validateContextDiagnostics,
  validateImpactSurfaces,
  ContextDiagnosticCode,
  Format,
} from "./context.ts";
export { explainGlobMatches, intersects, matchesAny, matchesAnyFile, normalizePath, pathToImportUrl, relative, splitList, toRepoRelativePath, unique } from "./core-utils.ts";
export { DefinitionTargetKind, definitionTargetDocs, definitionTargetFiles, definitionTargetRows, definitionTargetSummary } from "./definition-target.ts";
export type { DefinitionTarget } from "./definition-target.ts";
export {
  buildDefinitionGraph,
  DefinitionGraphDiagnosticSeverity,
  DefinitionGraphEdgeKind,
  DefinitionGraphNodeKind,
} from "./definition-graph.ts";
export type { DefinitionGraph, DefinitionGraphDiagnostic, DefinitionGraphEdge, DefinitionGraphNode } from "./definition-graph.ts";
export {
  conventionAnchor,
  conventionDocsReference,
  renderConvention,
  resolveConventionGeneratedDocsPath,
  validateGeneratedConventionDocsPath,
} from "./convention-render.ts";
export type { ProjectFileDiscovery } from "./discovery.ts";
export { discoverProjectFiles, FileDiscoveryMode, listFiles, listProjectFiles, matchesProjectFileScope } from "./discovery.ts";
export type { DocSnippet } from "./docs.ts";
export { normalizeMarkdownHeading, parseMarkdownDoc, resolveDocsReferences, validateDocsReference } from "./docs.ts";
export type { GitCommitInfo, GitFileDiff, GitFileHistory } from "./git.ts";
export { getChangedFiles, getGitFileDiff, getGitFileHistory, getGitRoot } from "./git.ts";

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
