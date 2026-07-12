export type {
  ContextConfig,
  ContextPaths,
  ContextDiagnostic,
  ContextReferenceValidator,
  ContextValidationInput,
  Baseline,
  ChangePolicy,
  ImpactSurface,
  ProposedImpactNote,
} from "./context.ts";
export type { ProjectFileDiscovery } from "./discovery.ts";
export type { DocSnippet } from "./docs.ts";
export {
  createDefaultConfig,
  createPaths,
  loadBaseline,
  loadConfig,
  loadImpactSurfaces,
  loadProposedImpactNotes,
  resolveRootDir,
  validateConfig,
  validateContext,
  validateContextDiagnostics,
  validateImpactSurfaces,
  ContextDiagnosticCode,
  Format,
} from "./context.ts";
export { fail } from "./core.ts";
export {
  OpenCanonAgentEntryFile,
  OpenCanonAgentEntryFiles,
  patchOpenCanonAgentEntryBlock,
  renderOpenCanonAgentEntryBlock,
  validateOpenCanonAgentEntryContent,
} from "./agent-entry.ts";
export type { OpenCanonAgentEntryFile as OpenCanonAgentEntryFileType } from "./agent-entry.ts";
export {
  ChangeCheckRunEventSchema,
  ChangeCheckRunAdmissionResultSchema,
  ChangeCheckRunPruneResultSchema,
  ChangeCheckRunEventType,
  ChangeCheckRunSchema,
  ChangeCheckRunStatus,
  ChangeCheckRunStatusSchema,
  StartChangeCheckRunsResponseSchema,
} from "./contracts-change-runs.ts";
export type {
  ChangeCheckRun,
  ChangeCheckRunAdmissionResult,
  ChangeCheckRunEvent,
  ChangeCheckRunEventQuery,
  ChangeCheckRunPruneRequest,
  ChangeCheckRunPruneResult,
  ChangeCheckRunQuery,
  StartChangeCheckRunsResponse,
} from "./contracts-change-runs.ts";
export { CommitApprovalsIgnoreEntries, GeneratedStateIgnoreEntries, GeneratedStateIgnoreProbePaths, InitStateFilePath } from "./generated-state.ts";
export type { CommitApprovalContext, CommitApprovalRecord, CommitApprovalsFile, CommitGateApprovalChoice, ResolvedCommitGate, PendingCommitGate, PendingCommitGatesFile } from "./commit-approvals.ts";
export {
  createCommitApprovalContext,
  createCommitApprovalRecord,
  getCommitGateFiles,
  commitGateApprovalChoices,
  commitGateAgentProtocol,
  commitGateFallbackProtocol,
  loadCommitApprovalsWithDiagnostics,
  loadPendingCommitGates,
  toPendingCommitGates,
  resolveCommitGates,
  saveCommitApprovals,
  savePendingCommitGates,
  upsertCommitApproval,
} from "./commit-approvals.ts";
export { explainGlobMatches, intersects, matchesAny, matchesAnyFile, parseVersionParts, pathToImportUrl, relative, satisfiesMinimumVersion, splitList, toRepoRelativePath, unique } from "./core-utils.ts";
export { branch, BranchBuilder } from "./branch.ts";
export { Semaphore, boundedMap, boundedMapSettled } from "./concurrency.ts";
export {
  err,
  errFromDiagnostics,
  errFromProblem,
  flatMapResult,
  isErr,
  isOk,
  mapResult,
  mapResultError,
  matchResult,
  ok,
  resultAll,
  resultCollect,
  tryResult,
  tryResultAsync,
  unwrapResultOr,
} from "./result.ts";
export type { ErrResult, OkResult, Result, ResultMatch } from "./result.ts";
export { RetryExhaustedError, RetryJitterMode, withRetry } from "./retry.ts";
export type { RetryPolicy } from "./retry.ts";
export { JsonParseError, JsonSerializeError, parseJson, stringifyJson } from "./safe-json.ts";
export { Singleflight } from "./singleflight.ts";
export { DefinitionTargetKind, definitionTargetDocs, definitionTargetFiles, definitionTargetRows, definitionTargetSummary } from "./definition-target.ts";
export type { DefinitionTarget } from "./definition-target.ts";
export {
  OpenCanonSkillArtifacts,
  OpenCanonSkillFilePath,
  OpenCanonSkillRoot,
  validateOpenCanonSkillArtifacts,
  writeOpenCanonSkillArtifacts,
} from "./opencanon-skill.ts";
export type { OpenCanonSkillArtifact } from "./opencanon-skill.ts";
export {
  buildDefinitionGraph,
  DefinitionGraphDiagnosticSeverity,
  DefinitionGraphEdgeKind,
  DefinitionGraphNodeKind,
} from "./definition-graph.ts";
export type { DefinitionGraph, DefinitionGraphDiagnostic, DefinitionGraphEdge, DefinitionGraphFileCoverage, DefinitionGraphNode } from "./definition-graph.ts";
export { AreaCheckKind, AreaRenderKind, AreaRenderStyle, defineArea, resolveAreas } from "./area.ts";
export type { Area, AreaBehavior, AreaCheck, AreaGovernance, AreaId, AreaOwnership, AreaRender, AreaStory, AreaResolution } from "./area.ts";
export {
  areaAnchor,
  areaDocsReference,
  renderArea,
  resolveAreaGeneratedDocsPath,
  validateGeneratedAreaDocsPath,
} from "./area-render.ts";
export type { AreaGraphMetadata, LoadedAreaGraph } from "./area-loader.ts";
export { loadAreaGraph } from "./area-loader.ts";
export { SpecCheckKind, SpecRenderKind, SpecRenderStyle, defineSpec, resolveSpecs } from "./spec.ts";
export type { Spec, SpecCheck, SpecGovernance, SpecId, SpecRender, SpecResolution, SpecRule, SpecScenario, SpecScope } from "./spec.ts";
export {
  renderSpec,
  resolveSpecGeneratedDocsPath,
  specAnchor,
  specDocsReference,
  validateGeneratedSpecDocsPath,
} from "./spec-render.ts";
export type { LoadedSpecGraph, SpecGraphMetadata } from "./spec-loader.ts";
export { loadSpecGraph } from "./spec-loader.ts";
export { ChangeCheckKind, ChangeKind, ChangeRenderKind, ChangeRenderStyle, defineChange, resolveChanges } from "./change.ts";
export type { Change, ChangeCheck, ChangeId, ChangeIntent, ChangeKind as ChangeKindType, ChangeLinks, ChangePlanItem, ChangeRender, ChangeRenderStyle as ChangeRenderStyleType, ChangeResolution, ChangeScope, ChangeTask, ChangeUpdates } from "./change.ts";
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
  validateChangeLifecycleTransition,
} from "./change-state.ts";
export type { ChangeBlockedWorkItem, ChangeCheckState, ChangeEventSummary, ChangeLifecycleTransitionInput, ChangeReadyWorkItem, ChangeTaskState, ChangeWorkQueue } from "./change-state.ts";
export {
  changeAnchor,
  changeDocsReference,
  renderChange,
  resolveChangeGeneratedDocsPath,
  validateGeneratedChangeDocsPath,
} from "./change-render.ts";
export type { ChangeGraphMetadata, LoadedChangeGraph } from "./change-loader.ts";
export { loadChangeGraph } from "./change-loader.ts";
export { ConventionAppliesKind, ConventionDefinitionKind, ConventionRenderKind, ConventionRenderStyle, ConventionRuntimeKind, defineConvention, conventionToValidator, resolveConventions, lookupConvention } from "./convention.ts";
export type { Convention, ConventionId, Applies, Render, RenderStyle, Runtime, RuntimeBody, ConventionResolution } from "./convention.ts";
export type {
  ConventionScopeSource,
  GoverningConventionOptions,
  GoverningConventionSummary,
  GoverningConventionsResult,
  ImpactSurfaceConventionMatch,
  ImpactSurfaceConventionResolution,
  MissingConventionAdvisory,
} from "./convention-scope.ts";
export {
  conventionAppliesToFile,
  DefaultGoverningConventionLimit,
  isMeaningfulConventionFile,
  resolveGoverningConventionsForFiles,
  resolveImpactSurfaceConventionsForFiles,
} from "./convention-scope.ts";
export {
  conventionAnchor,
  conventionDocsReference,
  renderConvention,
  resolveConventionGeneratedDocsPath,
  validateGeneratedConventionDocsPath,
} from "./convention-render.ts";
export type {
  AreaHistoryTarget,
  ChangeHistoryTarget,
  ConventionHistoryCommit,
  ConventionHistoryTarget,
  DefinitionHistoryKind,
  DefinitionHistoryTarget,
  GitCommandResult,
  ImpactEvolutionTarget,
  RelatedCommitGitArgs,
  SpecHistoryTarget,
} from "./convention-history.ts";
export {
  buildDefinitionDiffGitArgs,
  buildDefinitionHistoryGitArgs,
  buildDefinitionVersionsGitArgs,
  buildConventionDiffGitArgs,
  buildConventionHistoryGitArgs,
  buildConventionVersionsGitArgs,
  buildImpactEvolutionGitArgs,
  buildRelatedDefinitionCommitsGitArgs,
  buildRelatedCommitsGitArgs,
  ConventionGitLogFormat,
  dedupeCommits,
  loadAreaHistoryTarget,
  loadChangeHistoryTarget,
  loadConventionHistoryTarget,
  loadImpactEvolutionTarget,
  loadSpecHistoryTarget,
  parseConventionGitLog,
  resolveAreaDocFiles,
  resolveChangeDocFiles,
  resolveConventionDefinitionFiles,
  resolveConventionDefinitionFilesFromSources,
  resolveConventionDocFiles,
  resolveDefinitionFiles,
  resolveSpecDocFiles,
  runGit,
} from "./convention-history.ts";
export {
  discoverProjectFiles,
  FileDiscoveryMode,
  isSupportedSourceFile,
  listFiles,
  listProjectFiles,
  matchesProjectFileScope,
} from "./discovery.ts";
export {
  createOpenCanonProblem,
  createProjectDefinitionMissingProblem,
  formatOpenCanonProblem,
  isOpenCanonProblem,
  OpenCanonProblemCode,
  OpenCanonProblemSchemaId,
  OpenCanonProblemSource,
  parseOpenCanonProblem,
  parseOpenCanonProblemFromError,
  serializeOpenCanonProblem,
} from "./problem.ts";
export type { OpenCanonProblem, OpenCanonProblemCode as OpenCanonProblemCodeType, OpenCanonProblemInput, OpenCanonProblemSource as OpenCanonProblemSourceType } from "./problem.ts";
export {
  normalizeMarkdownHeading,
  parseMarkdownDoc,
  resolveDocsReferences,
} from "./docs.ts";
export {
  createRenderLinkContext,
  renderAreaMarkdownLink,
  renderChangeMarkdownLink,
  renderConventionMarkdownLink,
  renderDefinitionMarkdownLink,
  renderDocsMarkdownLink,
  renderImpactSurfaceMarkdownLink,
  renderLinkContextForDocs,
  renderSpecMarkdownLink,
} from "./render-links.ts";
export type { RenderLinkContext, RenderLinkContextInput, RenderLinkTarget } from "./render-links.ts";
export type { GitCommitInfo, GitFileDiff, GitFileHistory } from "./git.ts";
export { getChangedFiles, getGitFileDiff, getGitFileHistory, getGitRoot } from "./git.ts";
export type {
  BuildRepoGraphRequest,
  BuildRepoGraphResult,
  CallFact,
  CanonEvent,
  CanonEventQuery,
  CanonFinding,
  CanonFix,
  CommentFact,
  ContextRequest,
  RuntimeHealth,
  RuntimeHealthSummary,
  RuntimeValidatorGraphSummary,
  RuntimeProductModelState,
  RuntimeResponse,
  RuntimeState,
  RuntimeProjectSummary,
  RuntimeWorkerJob,
  DeclarationFact,
  DiagnosticFact,
  DomainEdge,
  DuplicateFact,
  ChangePolicy as ContractChangePolicy,
  CanonDocSnippet,
  EnumMemberFact,
  ExportFact,
  ExtractFactsRequest,
  ExtractFactsResult,
  FactDiagnostic,
  FactKind,
  FileFacts,
  FindingKind,
  ImpactSurface as ContractImpactSurface,
  ImportEdgeFact,
  ImportFact,
  InitializerFact,
  Language,
  LiteralFact,
  ObjectPropertyFact,
  ProposedImpactNote as ContractProposedImpactNote,
  ReferenceFact,
  AnnotationFact,
  BaselineFinding,
  Baseline as ContractBaseline,
  ExternalTool,
  EmbedSemanticTextsRequest,
  EmbedSemanticTextsResult,
  GenerateTextRequest,
  GenerateTextResult,
  EngineVersion,
  EngineProjectStatus,
  OpenProjectRequest,
  Position,
  ProductModelDefinitionGraph,
  ProductModelProjection,
  ProductModelProjectionCounts,
  ProjectContextAskResult,
  ProjectContextBacklinksResult,
  ProjectContextCoverageFile,
  ProjectContextCoverageResult,
  ProjectContextEvidence,
  ProjectContextLink,
  ProjectContextSearchResult,
  Recommendation,
  ListSemanticChunksRequest,
  ListSemanticChunksResult,
  ReadSemanticIndexStatusRequest,
  ReadSemanticIndexStatusResult,
  ReadProductModelProjectionResult,
  RepoGraph,
  ResolvedProjectSettings,
  ResolvedProjectSettingsInput,
  ScanAndDiffRequest,
  ScanAndDiffResult,
  SymbolFact,
  ValidateRequest,
  ValidatorContract,
  ValidatorScope,
  WatcherEventBatch,
  WatcherStartRequest,
  WatcherStartResult,
  ProjectRefresh,
  WriteProductModelProjectionRequest,
  WorkspaceNode,
  IndexCodeGraphRequest,
  IndexCodeGraphResult,
  SearchSymbolsRequest,
  SearchSymbolsResult,
  SearchReferencesRequest,
  SearchReferencesResult,
  SearchGraphEdgesRequest,
  SearchGraphEdgesResult,
  SearchSemanticIndexRequest,
  SearchSemanticIndexResult,
  SemanticChunkEmbedding,
  SemanticChunkKind,
  SemanticChunkMetadata,
  SemanticDistance,
  SemanticEmbeddingProvider,
  SemanticIndexDiagnostic,
  SemanticIndexNode,
  SemanticIndexNodeKind,
  SemanticIndexSnapshot,
  SemanticIndexStatusValue,
  SemanticSearchResult,
  CodeGraphEdge,
  CodeReference,
  CodeSymbol,
  CodeSymbolKind,
  WriteSemanticIndexDeltaRequest,
  WriteSemanticIndexRequest,
} from "./contracts.ts";
export {
  AnnotationFactSchema,
  BaselineFindingSchema,
  BaselineSchema,
  BuildRepoGraphRequestSchema,
  BuildRepoGraphResultSchema,
  CallFactSchema,
  CanonEventSchema,
  CanonEventQueryMode,
  CanonFindingSchema,
  CanonFixSchema,
  CommentFactSchema,
  ContextRequestSchema,
  RuntimeFailureSchema,
  RuntimeHealthSchema,
  RuntimeHealthSummarySchema,
  RuntimeValidatorGraphSummarySchema,
  RuntimeProductModelStateSchema,
  RuntimeResponseSchema,
  RuntimeStateSchema,
  RuntimeSuccessSchema,
  RuntimeWorkerJobKindValue,
  RuntimeWorkerJobSchema,
  RuntimeWorkerJobStatusValue,
  RuntimeProjectSummarySchema,
  summarizeRuntimeHealth,
  DeclarationFactSchema,
  DiagnosticSeverity,
  DiagnosticFactSchema,
  DocSnippetSchema,
  DomainEdgeSchema,
  DuplicateFactSchema,
  ChangePolicySchema,
  EnumMemberFactSchema,
  ExternalToolSchema,
  ExternalToolCommandSchema,
  ExternalToolDefinitionSchema,
  ExportFactSchema,
  ExtractFactsRequestSchema,
  ExtractFactsResultSchema,
  FactDiagnosticSchema,
  FactKindSchema,
  FileFactsSchema,
  FindingKindSchema,
  ImpactSurfaceSchema,
  ImportEdgeFactSchema,
  ImportFactSchema,
  InitializerFactSchema,
  LanguageSchema,
  LiteralFactSchema,
  ObjectPropertyFactSchema,
  ProposedImpactNoteSchema,
  ReferenceFactSchema,
  EngineVersionSchema,
  EngineProjectStatusSchema,
  OpenProjectRequestSchema,
  PositionSchema,
  ProductModelDefinitionGraphSchema,
  ProductModelProjectionCountsSchema,
  ProductModelProjectionSchema,
  ProjectContextAskResultSchema,
  ProjectContextBacklinksResultSchema,
  ProjectContextCoverageFileSchema,
  ProjectContextCoverageResultSchema,
  ProjectContextEvidenceSchema,
  ProjectContextLinkSchema,
  ProjectContextSearchResultSchema,
  RecommendationSchema,
  ListSemanticChunksRequestSchema,
  ListSemanticChunksResultSchema,
  ReadSemanticIndexStatusRequestSchema,
  ReadSemanticIndexStatusResultSchema,
  ReadProductModelProjectionResultSchema,
  RepoGraphSchema,
  ResolvedProjectSettingsSchema,
  ScanAndDiffRequestSchema,
  ScanAndDiffResultSchema,
  SymbolFactSchema,
  ValidateRequestSchema,
  ValidatorContractSchema,
  ValidatorScopeSchema,
  WatcherEventBatchSchema,
  WatcherStartRequestSchema,
  WatcherStartResultSchema,
  ProjectRefreshSchema,
  ProjectRefreshModeValue,
  ProjectRefreshStatusValue,
  WriteProductModelProjectionRequestSchema,
  WorkspaceNodeSchema,
  IndexCodeGraphRequestSchema,
  IndexCodeGraphResultSchema,
  SearchSymbolsRequestSchema,
  SearchSymbolsResultSchema,
  SearchReferencesRequestSchema,
  SearchReferencesResultSchema,
  SearchGraphEdgesRequestSchema,
  SearchGraphEdgesResultSchema,
  EmbedSemanticTextsRequestSchema,
  EmbedSemanticTextsResultSchema,
  SearchSemanticIndexRequestSchema,
  SearchSemanticIndexResultSchema,
  GenerateTextRequestSchema,
  GenerateTextResultSchema,
  SemanticChunkEmbeddingSchema,
  SemanticChunkKindSchema,
  SemanticChunkMetadataSchema,
  SemanticDistanceSchema,
  SemanticEmbeddingTaskSchema,
  SemanticEmbeddingProviderSchema,
  SemanticIndexDiagnosticSchema,
  SemanticIndexNodeSchema,
  SemanticIndexNodeKindSchema,
  SemanticIndexSnapshotSchema,
  SemanticIndexStatusValueSchema,
  SemanticSearchResultSchema,
  CodeGraphEdgeSchema,
  CodeReferenceSchema,
  CodeSymbolSchema,
  CodeSymbolKindSchema,
  SymbolRangeSchema,
  codeSymbolKindValues,
  factKindValues,
  diagnosticSeverityValues,
  externalToolMissingSeverityValues,
  ExternalToolMissingSeverity,
  languageValues,
  semanticChunkKindValues,
  semanticDistanceValues,
  semanticEmbeddingTaskValues,
  semanticIndexNodeKindValues,
  semanticIndexStatusValues,
  validatorSeverityValues,
  validatorScopeValues,
  WriteSemanticIndexDeltaRequestSchema,
  WriteSemanticIndexRequestSchema,
} from "./contracts.ts";
export {
  createSemanticChunkId,
  DefaultSemanticIndexId,
  estimateSemanticTokens,
  semanticEmbeddingConfigHash,
  semanticEmbeddingIdentityHash,
  semanticEmbeddingRecordHash,
  SemanticChunkerVersion,
  SemanticEmbeddingProducerVersion,
  SemanticIndexVersion,
  semanticChunkTreeHash,
  semanticPreview,
  semanticStableHash,
  semanticTextHash,
} from "./semantic-index.ts";
export type { SemanticHashInput } from "./semantic-index.ts";
export {
  DefaultNativeSemanticEmbeddingModelId,
  DefaultSemanticEmbeddingConfig,
  DefaultSemanticEmbeddingModelId,
  semanticEmbeddingModel,
  SemanticEmbeddingModelId,
  semanticEmbeddingModelIds,
  SemanticEmbeddingModels,
  SemanticEmbeddingProviderKind,
} from "./semantic-models.ts";
export type { SemanticEmbeddingConfig, SemanticEmbeddingModelDefinition } from "./semantic-models.ts";
export type { ResolvedExternalTool } from "./external-tools.ts";
export { normalizeExternalTool, resolveExternalTool, validateExternalTool } from "./external-tools.ts";
export type {
  OpenCanonDiagnostic,
  OpenCanonDiagnosticsErrorPayload,
  OpenCanonErrorCode,
  OpenCanonErrorPayload,
  OpenCanonErrorPayloadKind as OpenCanonErrorPayloadKindType,
  OpenCanonFailure,
  OpenCanonProblemErrorPayload,
} from "./errors.ts";
export {
  OpenCanonDiagnosticsErrorPayloadSchema,
  OpenCanonDiagnosticSchema,
  OpenCanonError,
  OpenCanonErrorCodeSchema,
  OpenCanonErrorPayloadKind,
  OpenCanonErrorPayloadSchema,
  OpenCanonFailureSchema,
  OpenCanonProblemErrorPayloadSchema,
  createOpenCanonDiagnosticsError,
  createOpenCanonDiagnostic,
  createOpenCanonFailure,
  createOpenCanonProblemError,
  createOpenCanonProblemFailure,
  formatOpenCanonErrorPayload,
  formatOpenCanonDiagnostics,
  getOpenCanonErrorDiagnostics,
  getOpenCanonErrorProblem,
  openCanonErrorCodeValues,
  parseOpenCanonErrorPayload,
  throwOpenCanonError,
} from "./errors.ts";
export { writeAtomicBinaryFileSync, writeAtomicJsonFileSync, writeAtomicTextFileSync } from "./atomic.ts";
export type { ResolvedInsideRootResult, SafeRelativePathResult } from "./paths.ts";
export { resolveInsideRoot, safeRelativePath } from "./paths.ts";
export type {
  BaselineApi,
  CallInfo,
  CommentInfo,
  DomainEdge as ValidatorDomainEdge,
  FactsApi,
  Finding,
  FindingFix,
  CommitGate,
  CommitGateEvidence,
  CommitGateInput,
  FolderInfo,
  GraphApi,
  ImpactApi,
  ImpactRequiredChecks,
  ImportEdge,
  JsonRead,
  ProjectAnnotationFact,
  ProjectCallFact,
  ProjectComment,
  ProjectDiagnosticFact,
  ProjectDuplicateFact,
  ProjectExportFact,
  ProjectFile,
  ProjectGraphEdge,
  OpenCanonProjectIndex,
  OpenCanonProjectIndexFile,
  ProjectLiteralFact,
  ProjectReferenceFact,
  RuntimeContextCoverage,
  RuntimeDefinition,
  ProjectSymbolFact,
  ReportInput,
  Severity,
  TextMatch,
  TextEdit,
  FileRead,
  ValidationContext,
  WorkspaceGraph,
  WorkspacePackage,
} from "./validator-types.ts";
export { CommitGateApprovalScope, FixSafety, ImportEdgeKind, ProjectSymbolKind, ValidatorDomain, WorkspaceKind } from "./validator-types.ts";
export { setProjectAstFactsProviderFactory, getProjectAstFactsProvider } from "./project-files.ts";
export { ProjectFileLanguage, LANGUAGE_DESCRIPTORS, languageDescriptor, descriptorForExtension, usesProperParser, namingIdiom, engineExtractableExtensions, isEngineExtractableFile, isCodeGraphIndexableFile, importRewritableExtensions, engineSourceLanguage, GraphModeKind } from "./language-registry.ts";
export type { LanguageDescriptor, LanguageId, LanguageRole, FactExtractor, FactCoverage, SemanticCapability, GraphMode, RefactorLevel, RefactorOperation, IdentifierRole, NamingStyle, EngineSourceLanguage } from "./language-registry.ts";
export type { ProjectAstFactsProvider, ProjectAstFactsProviderFactory } from "./project-files.ts";
export type {
  Validator,
  ValidatorArgs,
  ValidatorDefinition,
  ConventionFactory,
  ConventionFactoryBaseOptions,
  FindingValidationContext,
  ValidatorRuntime,
  ValidatorSummary,
  ValidatorSummaryInput,
  ValidatorVisual,
} from "./validator.ts";
export {
  createConventionFactory,
  createRuntime,
  createValidationContext,
  createValidationContextFromFixture,
  createValidationContextFromFixtureFile,
  flushValidationContextCache,
  formatValidatorApplies,
  resolveValidators,
  validateFindings,
  validateValidatorDefinitions,
  validatorMatchesAnyFile,
  validatorMatchesFile,
  SidecarTypeFactsProvider,
  DeclarationIndex,
  readSidecarPayloadDetailed,
  sidecarStatusFromRead,
  queryLiterals,
  siteKey,
  comparisonSites,
  resolveTypeFactsProvider,
  resolveTypeScriptSidecarStatus,
  resolveProducerStatuses,
  normalizeProducerStatusesForProject,
  resolveAuthoritativeProducerStatus,
  resolveArtifactTypeFactsProvider,
  resolveLiveTypeFactsProvider,
  prewarmTypeFacts,
  prewarmContextTypeFacts,
  installContextTypeFacts,
  resolveRunTypeFacts,
  setLiveTypeFactsProviderFactory,
  typedSidecarTsconfigHash,
  BatchProducerPolicy,
  InteractiveProducerPolicy,
  SupportedTypeScriptVersionRange,
  ProducerArtifactFreshness,
  ProducerArtifactId,
  ProducerLiveWorkerId,
  ProducerRunProfile,
  ProducerSourceKind,
  installedProducerPackageVersion,
  installedTypeScriptPackageJsonPath,
  installedTypeScriptVersion,
  isProducerToolchainAvailable,
  isSupportedTypeScriptVersion,
  membershipHashOf,
  listMembershipFiles,
  pickAuthoritativeStatus,
  producerDefinitionForLanguage,
  producerDefinitionHasArtifact,
  producerDefinitionHasLiveWorker,
  producerDefinitions,
  producerPackageJsonPath,
  producerPackageVersionSupport,
  producerSetupStatus,
  producerSourceForLanguage,
  typeScriptVersionSupport,
  unsupportedTypeScriptVersionDetail,
} from "./validator.ts";
export type { TypeFactsProvider, TypeSource, TypeSite, TypeResolution, LiteralValue, LiteralMember, LiteralUnionSyntax, FiniteLiteralSet, ProducerStatus, ProducerWarning, ProducerSnapshot, ProducerSnapshotEntry, ResolvedLiteralFact, SidecarEntry, SidecarPayload, SidecarSourceFile, SidecarCoverage, SidecarReadResult, SymbolId, LiteralQuery, RunTypeFacts, ProducerArtifactDefinition, ProducerDefinition, ProducerLiveWorkerDefinition, ProducerPackageToolchain, ProducerPolicy, ProducerRequiredConfig, ProducerSource, ProducerVersionRange } from "./validator.ts";
export { asFiniteLiteralSet, finiteLiteralIncludes, ProducerStatusKind, TypeResolutionKind } from "./validator.ts";
export type { TypeFactsProviderFactory } from "./validator.ts";
export type { FixtureFileApi, FixtureFileEntry, FixtureFileOptions, FixtureFileBuilder, FixtureTextFileInput, MaterializedFixture, FixtureDefinition, FixtureTextInput } from "./testing.ts";
export { materializeFixture, defineFixture } from "./testing.ts";
export type { FixApplicationResult, FixMode } from "./fixes.ts";
export { applyFindingFixes, FixModeValue, isFixAllowed } from "./fixes.ts";
export type { RefactorApplyResult, RefactorFileMove, RefactorPlan, RefactorPlanKind } from "./refactors.ts";
export { applyRefactorPlan, fixes, moveDir, moveFile, renamePackage, renameSymbol, splitModule, updateImports } from "./refactors.ts";
export type {
  EnumMemberInfo,
  ExportInfo,
  FunctionInfo,
  InitializerInfo,
  ImportInfo,
  LiteralInfo,
  ObjectPropertyInfo,
  TypeScriptDeclaration,
  TypeScriptEnumDeclaration,
  TypeScriptVariableDeclaration,
} from "./typescript.ts";
export { LiteralContext, LiteralValueKind, TypeScriptDeclarationKind } from "./typescript.ts";
export type { TreeBoundaryRule, TreeDefinition, TreeFileRules, TreeFolderRules, TreeGraphDefinition, TreeImportRules, TreeNode, TreePathDefinition } from "./tree.ts";
export { tree, validateTree, validateTreeDefinition } from "./tree.ts";
export type { DoctorCheck, DoctorFixResult, DoctorReport, DoctorRuntimeHealth } from "./doctor.ts";
export { applyDoctorFixes, buildDoctorReport, DoctorCheckGroup, DoctorStatus, renderDoctorFixMarkdown, renderDoctorMarkdown } from "./doctor.ts";
export type { AnalysisCache } from "./cache.ts";
export { getAnalysisCache } from "./cache.ts";
export type { LazyValue } from "./lazy.ts";
export { lazy } from "./lazy.ts";
export type { Resource, ResourceOptions, ResourceSignal } from "./resource.ts";
export { resource } from "./resource.ts";
export type { ProfileEntry, Profiler } from "./profiler.ts";
export { createProfiler, renderProfileMarkdown } from "./profiler.ts";
export type { ProjectContext, UncheckedProjectContext } from "./project.ts";
export { loadProjectContext, loadProjectContextUnchecked, loadValidators } from "./project.ts";
export type { ProjectTypesGeneratedFile, ProjectTypesGenerationPlan, ProjectTypesGenerationResult } from "./project-types.ts";
export {
  buildProjectTypesGeneration,
  generateProjectTypes,
  ProjectAliasesFilePath,
  ProjectAuthoringGeneratedDirPath,
  ProjectCoreAuthoringFilePath,
  ProjectTestingAuthoringFilePath,
  ProjectTypesFilePath,
  ProjectValidatorsAuthoringFilePath,
} from "./project-types.ts";
export type { ValidatorGraphMetadata, ValidatorGraphSourceSignature } from "./validator-graph.ts";
export { loadConventionGraph, readValidatorGraphSourceSignature } from "./validator-graph.ts";
export type {
  FeedbackArea,
  FeedbackChange,
  FeedbackImpactSurface,
  FeedbackInput,
  FeedbackRenderOptions,
  FeedbackResult,
  FeedbackScopeDrift,
  FeedbackChangeContext,
} from "./feedback.ts";
export { FeedbackDedupeScope, FeedbackHost, formatFeedbackResult, renderFeedbackMarkdown, runFeedback } from "./feedback.ts";
export type { HookInspection, HookInstallFileResult, HookInstallResult } from "./hook-install.ts";
export {
  claudeHookConfig,
  codexHookConfig,
  HookFileAction,
  HookInstallHost,
  HookInstallScope,
  installHook,
  inspectHookInstallations,
  openCodePluginSource,
  renderHookInspectionMarkdown,
  renderHookInstallResult,
} from "./hook-install.ts";
export type { HookFeedback } from "./hooks.ts";
export { appendOpenCodeFeedback, createHookFeedback, extractFilesFromPatchText, normalizeHookPayload, renderHookResponse } from "./hooks.ts";
export type { ProjectFileSnapshot } from "./project-files.ts";
export type { ValidationInput, ValidationResult, ValidatorOutcome } from "./validation.ts";
export { runValidation, selectValidators, sortFindings, validatorGraphHash, ValidatorOutcomeStatus } from "./validation.ts";
export type { ValidationResultCache } from "./validation-result-cache.ts";
export { createEphemeralValidationResultCache, createValidationResultCache, validationContextFiles, validationRuntimeFingerprint, validatorRunCacheKey } from "./validation-result-cache.ts";
export * from "./worktree.ts";
