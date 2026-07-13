export type { RuntimeServer, RuntimeServerOptions } from "./server.ts";
export { runtimeAuthHeaders } from "./auth.ts";
export { checkRuntimePrerequisites, startOpenCanonRuntime } from "./server.ts";
export type { ProjectStore, StoreSnapshotInput, StoreState } from "./state.ts";
export { createProjectStore, openProjectStore } from "./state.ts";
export { createProjectObservabilityExporter } from "./observability.ts";
export {
  buildProjectSemanticIndex,
  buildProjectSemanticIndexDelta,
  createSemanticEmbeddingBackend,
  semanticIndexProducerVersion,
  semanticSearchVectorForProvider,
} from "./semantic-index.ts";
export type { ProjectSemanticIndexDeltaInput, SemanticEmbeddingBackend } from "./semantic-index.ts";
export { createKnowledgeIndexManager } from "./knowledge-index-manager.ts";
export type { KnowledgeIndexManager, KnowledgeIndexProgress, KnowledgeIndexRunOptions, KnowledgeIndexRunResult } from "./knowledge-index-manager.ts";
export { snapshotFiles } from "./project-source-snapshot.ts";
export type { RuntimeSourceSnapshot, RuntimeFactFile } from "./project-source-snapshot.ts";
export {
  askProjectContext,
  listProjectContextChunks,
  projectContextBacklinks,
  projectContextCoverage,
  searchProjectContext,
} from "./project-context.ts";
export { createCliAstFactsProvider, engineProjectAstFactsProvider, withCliAstFactsProvider } from "./ast-facts-provider.ts";
export type { RuntimePrerequisites } from "./runtime.ts";
export { assertRuntimePrerequisites, runtimeVersionSummary, renderPrerequisiteFailure, requiredNodeRequirement, requiredNodeVersion } from "./runtime.ts";
export type { RuntimeSnapshot, RelatedCanon, RelatedCanonQuery } from "./snapshot.ts";
export { buildRuntimeSnapshot, buildRelatedCanon, gitDiffSnapshot, gitHistorySnapshot } from "./snapshot.ts";
export { normalizeRuntimePort, runOpenCanonStatusCommand, runProjectCommand, runServiceCommand } from "./cli.ts";
export type { LocalProtocolEndpoint, LocalProtocolPipeServer, LocalProtocolRawResponse, LocalProtocolRequest, LocalProtocolTransport } from "./local-protocol.ts";
export { httpLoopbackTransport, localPipeEndpoint, localProtocolEndpointFromEntry, localProtocolTransport, LocalTransportKind, pipeProtocolTransport, requestLocalJson, serveLocalProtocolPipe, streamLocalText } from "./local-protocol.ts";
export { defaultRuntimeNamespace, defaultServiceRegistryPath, projectProcessStateDirectory, runtimeNamespaceForRegistry, RuntimeNamespaceEnv, StableRuntimeNamespace, validateRuntimeNamespace } from "./service-namespace.ts";
export type { LocalProtocolStreamRequest } from "./local-protocol.ts";
export type { TypeProducerRuntime, ProducerResolution } from "./type-producer/runtime.ts";
export { createTypeProducerRuntime, defaultTsconfigPath } from "./type-producer/runtime.ts";
export { LiveTypeProducerProvider } from "./type-producer/live-provider.ts";
export type {
  CreateManagedWorktreeInput,
  CreateManagedWorktreeResult,
  ReapWorktreesResult,
  RemoveManagedWorktreeResult,
  WorktreeClaimInput,
  WorktreeClaimResponse,
  WorktreeOwnerResponse,
  WorktreeReleaseInput,
  WorktreeReleaseResponse,
} from "./worktree-coordination.ts";
export {
  activeTaskLeaseSummaries,
  claimTaskLease,
  createManagedWorktree,
  listWorktreeOverview,
  listGlobalCanonEvents,
  mergeCanonEvents,
  reapWorktrees,
  releaseTaskLease,
  removeManagedWorktree,
  requireTaskLeaseOwner,
  resolveRepositoryIdentity,
  ensureWorktreeCoordinationSignal,
  worktreeCoordinationDbPath,
  worktreeCoordinationSignalPath,
  writeGlobalCanonEvent,
} from "./worktree-coordination.ts";
export type {
  ServiceActionDefinition,
  ServiceActionResult,
  ServiceClientEffect,
  ServiceProjectStatus,
} from "@opencanon/service-contracts";
export {
  ServiceActionCategory,
  ServiceActionId,
  ServiceActionScope,
  ServiceActionStatusValue,
  ServiceActionSurface,
  ServiceEffectKind,
  ServiceProjectStatusValue,
} from "@opencanon/service-contracts";
export type {
  RuntimeInspection,
  RuntimeRegistryEntry,
  ServiceActivityItem,
  ServiceOverview,
  ServiceOverviewRequest,
  ServiceProjectSummary,
  ServiceRecentProject,
  ServiceSummary,
  ProcessLifecycleEvent,
  ProcessLifecycleState,
  ProcessRestartState,
  RuntimeLifecycleTransitionResult,
  ReconcileProjectRuntimesResult,
  EnsureProjectRuntimeResult,
  ServiceInspection,
  ReadyRuntimeInspection,
  ServiceRegistryEntry,
  ProjectWorkerLease,
  ProjectWorkerLeaseHandle,
  RuntimeCliEntrypoint,
  ServiceServer,
  StartServiceResult,
  StartProjectRuntimeResult,
  StopProjectRuntimeResult,
  StopServiceResult,
  ServiceRepairResult,
} from "./service.ts";
export {
  RuntimeStatus,
  StartProjectRuntimeStatus,
  ProcessLifecycleStatus,
  ProcessLifecycleEventKind,
  ProcessLifecycleScope,
  RuntimeCliInvocationKind,
  LocalControlProtocolVersion,
  chooseRuntimePort,
  buildServiceOverview,
  runtimeLogPath,
  discoverOpenCanonProject,
  discoverOpenCanonProjectsFromRoots,
  ensureProjectRuntimeViaService,
  invokeServiceAction,
  serviceLogPath,
  inspectAllRuntimes,
  reconcileProjectRuntimes,
  inspectRuntimeEntry,
  inspectService,
  inspectProjectRuntime,
  waitForProjectRuntimeReady,
  isProcessRunning,
  openRuntimeUrl,
  acquireProjectWorkerLease,
  compareAndSetRuntimeLifecycle,
  projectRuntimePath,
  projectWorkerLeasePath,
  readRuntimeRegistry,
  readRuntimeLifecycleEvents,
  readRuntimeRegistryDiagnostics,
  readProjectWorkerLease,
  readServiceEntry,
  readProjectRuntimeEntry,
  forgetRuntimeEntry,
  forgetRuntimeEntryForPid,
  forgetServiceEntry,
  forgetServiceEntryForPid,
  renderRuntimeListMarkdown,
  renderRuntimeStatusMarkdown,
  renderLifecycleEventsMarkdown,
  renderServiceStatusMarkdown,
  repairServiceProcessState,
  resolveRuntimeCliEntrypoint,
  runtimeIdentityForEntrypoint,
  startService,
  startServiceServer,
  startProjectRuntime,
  stopService,
  stopProjectRuntime,
  serviceRegistryPath,
  setRuntimeLifecycleForLease,
  upsertServiceEntry,
  upsertRuntimeEntry,
  writeRuntimeRegistry,
  writeProjectRuntimeEntry,
} from "./service.ts";
