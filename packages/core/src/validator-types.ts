import type { FactKind, ValidatorScope } from "./contracts.ts";
import type { Baseline, ContextPaths, Decision, ImpactSurface, ProposedImpactNote } from "./core.ts";
import type { PatternExplanation } from "./globs.ts";
import type { TreeDefinition } from "./tree.ts";
import type { ExportInfo, FunctionInfo, ImportInfo, LiteralInfo, TypeScriptDeclaration } from "./typescript.ts";
import type { PythonClassInfo, PythonFunctionInfo, PythonImportInfo } from "./python.ts";

export type Severity = "error" | "warning";
export type FixSafety = "safe" | "suggested" | "manual";

export type TextEdit = {
  file: string;
  range: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  replacement: string;
};

export type FindingFix = {
  /** How confidently OpenCanon may apply this fix. `manual` fixes are diagnostic only. */
  safety: FixSafety;
  /** Human-readable remediation guidance shown with the finding. */
  description: string;
  /** Advisory command to print for humans. OpenCanon does not execute this command. */
  command?: string;
  /** Structured text edits applied by `opencanon validate --fix` when the safety mode allows it. */
  edits?: TextEdit[];
};

/** A validator diagnostic emitted against a file, folder path, or synthetic rule target. */
export type Finding = {
  /** Validator id that produced this finding. Filled automatically by `ctx.report()` and `file.report()`. */
  validatorId: string;
  /** Finding severity. Errors fail validation; warnings fail only with strict warning mode. */
  severity: Severity;
  /** Repo-relative file path, folder path, or synthetic target such as `<tree-definition>`. */
  file: string;
  /** 1-based line number. Use `1` for folder-level or whole-file findings. */
  line: number;
  /** Optional 1-based column number. */
  column?: number;
  /** Short actionable message shown in CLI, UI, and agent feedback. */
  message: string;
  fix?: FindingFix;
  /** Documentation references such as `docs/opencanon/canon/api.md#route-boundaries`. */
  docs?: string[];
  /** Decision ids this finding enforces. Usually inherited from the validator. */
  decisionIds?: string[];
};

export type CommitGateEvidence = {
  file?: string;
  line?: number;
  column?: number;
  message?: string;
  decisionIds?: string[];
  impactSurfaceIds?: string[];
};

export type CommitGateInput = {
  id: string;
  title: string;
  reason: string;
  /** User-facing question an agent must ask before recording approval. */
  question: string;
  /** Invalidation scope for this approval. Defaults to the exact staged diff for the gated files. */
  approvalScope?: CommitGateApprovalScope;
  file?: string;
  line?: number;
  evidence?: CommitGateEvidence[];
  decisionIds?: string[];
  impactSurfaceIds?: string[];
};

export type CommitGateApprovalScope = "staged-diff" | "file";

export type CommitGate = CommitGateInput & {
  validatorId: string;
  status?: "unresolved" | "approved";
  approvalId?: string;
};

export type ReportInput = {
  file: string;
  line: number;
  column?: number;
  message: string;
  fix?: FindingFix;
  docs?: string[];
  decisionIds?: string[];
};

export type FileReportInput = Omit<ReportInput, "file">;

export type TextMatch = {
  line: number;
  column: number;
  text: string;
  groups: string[];
};

export type ImportEdge = {
  from: ProjectFile;
  to?: ProjectFile;
  source: string;
  line: number;
  specifiers: string[];
  kind: "import" | "export";
  relativeDepth: number;
  resolution: "relative" | "alias" | "workspace" | "external" | "unresolved";
  resolvedPath?: string;
  fromPackage?: string;
  toPackage?: string;
};

export type FolderInfo = {
  path: string;
  depth: number;
  fileCount: number;
  empty: boolean;
};

export type CommentInfo = {
  line: number;
  column: number;
  text: string;
  kind: "line" | "block";
};

export type ProjectComment = CommentInfo & {
  file: ProjectFile;
};

export type ProjectExportFact = ExportInfo & {
  file: ProjectFile;
  language: ProjectFile["language"];
};

export type ProjectSymbolFact = {
  file: ProjectFile;
  language: ProjectFile["language"];
  line: number;
  column?: number;
  endLine?: number;
  name: string;
  kind: "function" | "class" | "method" | "variable" | "type" | "interface" | "enum" | "property" | "unknown";
  exported: boolean;
  params?: string[];
};

export type ProjectCallFact = {
  file: ProjectFile;
  language: ProjectFile["language"];
  line: number;
  column?: number;
  name: string;
  receiver?: string;
  callee: string;
};

export type ProjectLiteralFact = LiteralInfo & {
  file: ProjectFile;
  language: ProjectFile["language"];
};

export type ProjectReferenceFact = {
  file: ProjectFile;
  language: ProjectFile["language"];
  line: number;
  column?: number;
  name: string;
  kind: "identifier" | "import" | "export" | "call" | "type" | "text" | "unknown";
  targetPath?: string;
  targetName?: string;
};

export type ProjectAnnotationFact = {
  file: ProjectFile;
  language: ProjectFile["language"];
  line: number;
  column?: number;
  tag: string;
  value: string;
  raw: string;
  ownerName?: string;
};

export type ProjectDiagnosticFact = {
  file: string;
  line: number;
  column?: number;
  source: string;
  code?: string;
  message: string;
  severity: "error" | "warning" | "info";
};

export type ProjectDuplicateFact = {
  file: ProjectFile;
  language: ProjectFile["language"];
  line: number;
  column?: number;
  kind: "literal" | "object-shape" | "schema-shape" | "sql-fragment" | "ast-block" | "text";
  key: string;
  value: string;
  occurrences: number;
  files: string[];
};

export type FactsApi = {
  imports(): ImportEdge[];
  exports(): ProjectExportFact[];
  symbols(): ProjectSymbolFact[];
  calls(): ProjectCallFact[];
  literals(): ProjectLiteralFact[];
  comments(): ProjectComment[];
  references(): ProjectReferenceFact[];
  annotations(): ProjectAnnotationFact[];
  diagnostics(): ProjectDiagnosticFact[];
  duplicates(): ProjectDuplicateFact[];
};

export type ImpactRequiredChecks = {
  surface: ImpactSurface;
  files: ProjectFile[];
  requiresTests: string[];
  requiresDocs: string[];
  requiresDecision: boolean;
  reviewers: string[];
};

export type DomainEdge = {
  from: string;
  to: string;
  kind: "owns" | "depends-on" | "downstream";
  surfaceId: string;
};

export type ImpactApi = {
  surfaces(): ImpactSurface[];
  proposals(): ProposedImpactNote[];
  surfacesForFiles(files: Array<string | ProjectFile>): ImpactSurface[];
  downstreamOf(surfaceId: string): string[];
  requiredChecks(files: Array<string | ProjectFile>): ImpactRequiredChecks[];
  domainEdges(): DomainEdge[];
};

export type BaselineApi = {
  all(): Baseline;
  key(finding: Pick<Finding, "validatorId" | "file" | "line" | "message">): string;
  isKnown(finding: Pick<Finding, "validatorId" | "file" | "line" | "message">): boolean;
};

export type ProjectGraphEdge = {
  source?: ProjectSymbolFact;
  target: ProjectSymbolFact;
  reference: ProjectReferenceFact;
  kind: "call" | "reference";
  confidence: "exact" | "ambiguous";
};

export type OpenCanonProjectIndexFile = {
  imports: string;
  exports: string;
  functions: string;
  stringLiterals: string;
  symbols: string;
  calls: string;
};

/**
 * Project-specific generated type index.
 *
 * `opencanon project-types generate` augments this interface from
 * `@opencanon/project`, allowing `ctx.typed.*` helpers to narrow to the files,
 * imports, exports, symbols, literals, and caller/callee lookups discovered in the local repo.
 */
export interface OpenCanonProjectIndex {}

type GeneratedProjectFiles = OpenCanonProjectIndex extends { files: infer Files } ? Files : never;
type GeneratedCallees = OpenCanonProjectIndex extends { callees: infer Callees } ? Callees : never;
type GeneratedCallers = OpenCanonProjectIndex extends { callers: infer Callers } ? Callers : never;
type StringKeyOf<T> = Extract<keyof T, string>;
type FileIndex<F extends string> = F extends keyof GeneratedProjectFiles ? GeneratedProjectFiles[F] : OpenCanonProjectIndexFile;
type FileValue<F extends string, K extends keyof OpenCanonProjectIndexFile> = FileIndex<F> extends Record<K, infer Value> ? Extract<Value, string> : string;
type BroadProjectIndex = string extends StringKeyOf<GeneratedProjectFiles> ? true : [GeneratedProjectFiles] extends [never] ? true : false;

/** Repo-relative file path literals from the generated project index, or `string` before generation. */
export type ProjectIndexFilePath = BroadProjectIndex extends true ? string : StringKeyOf<GeneratedProjectFiles>;
/** Import source literals for one indexed file, or `string` before generation. */
export type ProjectImportSourceIn<F extends string = ProjectIndexFilePath> = FileValue<F, "imports">;
/** Export name literals for one indexed file, or `string` before generation. */
export type ProjectExportNameIn<F extends string = ProjectIndexFilePath> = FileValue<F, "exports">;
/** Function name literals for one indexed file, or `string` before generation. */
export type ProjectFunctionNameIn<F extends string = ProjectIndexFilePath> = FileValue<F, "functions">;
/** String literal value literals for one indexed file, or `string` before generation. */
export type ProjectStringLiteralIn<F extends string = ProjectIndexFilePath> = FileValue<F, "stringLiterals">;
/** Symbol name literals for one indexed file, or `string` before generation. */
export type ProjectSymbolNameIn<F extends string = ProjectIndexFilePath> = FileValue<F, "symbols">;
/** Call callee literals for one indexed file, or `string` before generation. */
export type ProjectCallNameIn<F extends string = ProjectIndexFilePath> = FileValue<F, "calls">;
/** Stable symbol id literals from the generated project index, or `string` before generation. */
export type ProjectSymbolId = OpenCanonProjectIndex extends { symbolIds: infer Symbols } ? Extract<Symbols, string> : string;
/** Callee symbol id literals for a generated caller symbol id, or `string` before generation. */
export type ProjectCalleeOf<S extends string> =
  S extends keyof GeneratedCallees ? Extract<GeneratedCallees[S], string> : ProjectSymbolId;
/** Caller symbol id literals for a generated callee symbol id, or `string` before generation. */
export type ProjectCallerOf<S extends string> =
  S extends keyof GeneratedCallers ? Extract<GeneratedCallers[S], string> : ProjectSymbolId;

export type TypedImportFact<F extends string = ProjectIndexFilePath> = Omit<ImportEdge, "from" | "source"> & {
  file: F;
  from: ProjectFile & { path: F };
  source: ProjectImportSourceIn<F>;
};

export type TypedExportFact<F extends string = ProjectIndexFilePath> = Omit<ProjectExportFact, "file" | "name"> & {
  file: ProjectFile & { path: F };
  name: ProjectExportNameIn<F>;
};

export type TypedFunctionFact<F extends string = ProjectIndexFilePath> = Omit<ProjectSymbolFact, "file" | "kind" | "name"> & {
  file: ProjectFile & { path: F };
  kind: "function";
  name: ProjectFunctionNameIn<F>;
};

export type TypedStringLiteralFact<F extends string = ProjectIndexFilePath> = Omit<ProjectLiteralFact, "file" | "value"> & {
  file: ProjectFile & { path: F };
  value: ProjectStringLiteralIn<F>;
};

export type TypedSymbolFact<F extends string = ProjectIndexFilePath> = Omit<ProjectSymbolFact, "file" | "name"> & {
  file: ProjectFile & { path: F };
  name: ProjectSymbolNameIn<F>;
  id: ProjectSymbolId;
};

export type TypedCallFact<F extends string = ProjectIndexFilePath> = Omit<ProjectCallFact, "file" | "callee"> & {
  file: ProjectFile & { path: F };
  callee: ProjectCallNameIn<F>;
};

export type TypedCallEdge<S extends string = ProjectSymbolId> = ProjectGraphEdge & {
  from: S;
  to: ProjectCalleeOf<S>;
};

export type TypedCallerEdge<S extends string = ProjectSymbolId> = ProjectGraphEdge & {
  from: ProjectCallerOf<S>;
  to: S;
};

export type TypedFactsApi = {
  /** Imports for one indexed file, narrowed to generated import source literals. */
  imports<F extends ProjectIndexFilePath>(file: F): TypedImportFact<F>[];
  /** Exports for one indexed file, narrowed to generated export name literals. */
  exports<F extends ProjectIndexFilePath>(file: F): TypedExportFact<F>[];
  /** Functions for one indexed file, narrowed to generated function name literals. */
  functions<F extends ProjectIndexFilePath>(file: F): TypedFunctionFact<F>[];
  /** String literals for one indexed file, narrowed to generated literal value literals. */
  stringLiterals<F extends ProjectIndexFilePath>(file: F): TypedStringLiteralFact<F>[];
  /** Symbols for one indexed file, narrowed to generated symbol name literals and stable symbol ids. */
  symbols<F extends ProjectIndexFilePath>(file: F): TypedSymbolFact<F>[];
  /** Calls for one indexed file, narrowed to generated callee literals. */
  calls<F extends ProjectIndexFilePath>(file: F): TypedCallFact<F>[];
  /** Callee edges for one generated symbol id. */
  callees<S extends ProjectSymbolId>(symbol: S): TypedCallEdge<S>[];
  /** Caller edges for one generated symbol id. */
  callers<S extends ProjectSymbolId>(symbol: S): TypedCallerEdge<S>[];
};

export type GraphApi = {
  symbols(): ProjectSymbolFact[];
  references(): ProjectReferenceFact[];
  callers(symbol: string | ProjectSymbolFact): ProjectGraphEdge[];
  callees(symbol: string | ProjectSymbolFact): ProjectGraphEdge[];
  impact(symbol: string | ProjectSymbolFact): ProjectGraphEdge[];
};

export type FileRead = {
  /** Requested repo-relative path. */
  path: string;
  /** Project file when the path belongs to the validation file graph. */
  file?: ProjectFile;
  /** File text when readable. */
  text?: string;
  /** Non-fatal read diagnostics. */
  diagnostics: string[];
};

export type JsonRead<T = unknown> = {
  /** Requested repo-relative path. */
  path: string;
  /** Project file when the path belongs to the validation file graph. */
  file?: ProjectFile;
  /** Parsed JSON data when valid. */
  data?: T;
  /** Non-fatal read or parse diagnostics. */
  diagnostics: string[];
};

export type WorkspaceKind = "root" | "app" | "package" | "workspace";

export type WorkspacePackage = {
  name: string;
  root: string;
  kind: WorkspaceKind;
  packageJson: Record<string, unknown>;
  dependencies: Record<string, string>;
  files: ProjectFile[];
};

export type WorkspaceGraph = {
  packages: WorkspacePackage[];
  byName(name: string): WorkspacePackage | undefined;
  ownerOf(file: string | ProjectFile): WorkspacePackage | undefined;
  importEdges(): ImportEdge[];
};

export type ProjectFile = {
  /** Repo-relative normalized path. */
  path: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Full file text, loaded lazily. */
  text: string;
  /** File lines split on CRLF or LF. */
  lines: string[];
  extension: string;
  language: "typescript" | "svelte" | "python" | "json" | "markdown" | "text";
  /** True when the file text includes a string or matches a RegExp. */
  has(pattern: RegExp | string): boolean;
  /** Find string or RegExp matches with 1-based line and column positions. */
  find(pattern: RegExp | string): TextMatch[];
  /** Parse this file as JSON without throwing. */
  json<T = unknown>(): JsonRead<T>;
  /** Return a 1-based line of text, or an empty string when absent. */
  lineAt(line: number): string;
  /** Test the file path against a glob. */
  matches(glob: string): boolean;
  /** Parsed comments from supported source files. */
  comments(): CommentInfo[];
  /** Build a finding attached to this file. */
  report(input: FileReportInput): Finding;
  ts: {
    imports(): ImportInfo[];
    exports(): ExportInfo[];
    functions(): FunctionInfo[];
    declarations(): TypeScriptDeclaration[];
    literals(): LiteralInfo[];
  };
  py: {
    imports(): PythonImportInfo[];
    functions(): PythonFunctionInfo[];
    classes(): PythonClassInfo[];
  };
};

export type ValidationContext = {
  /** All project files known to this validation run. */
  files: ProjectFile[];
  /** Files currently targeted by the CLI request, changed-file run, or fixture case. */
  targetFiles: ProjectFile[];
  /** True when validation is running in whole-project mode. */
  project: boolean;
  /** Structured facts over the current analysis scope. Prefer this over ad hoc text parsing. */
  facts: FactsApi;
  /** Generated-type-aware facade over facts and graph helpers. */
  typed: TypedFactsApi;
  /** Graph-shaped symbol/reference helpers over the current analysis scope. */
  graph: GraphApi;
  /** Impact-surface and change-policy helpers. */
  impact: ImpactApi;
  /** Baseline lookup helpers for known findings. */
  baseline: BaselineApi;
  /** Lookup a known project file by repo-relative path. */
  file(path: string): ProjectFile | undefined;
  /** Return known project files, optionally filtered by globs. */
  projectFiles(patterns?: string[]): ProjectFile[];
  /** Concise alias for `projectFiles(patterns)`. */
  byGlob(patterns: string[]): ProjectFile[];
  /** Read text from a project or context file without throwing. */
  text(path: string): FileRead;
  /** Read and parse JSON from a project or context file without throwing. */
  json<T = unknown>(path: string): JsonRead<T>;
  /** Read all known JSON files matching the supplied globs. */
  jsonFiles<T = unknown>(patterns: string[]): JsonRead<T>[];
  /** Import/export edges resolved from source files. */
  imports(): ImportEdge[];
  /** Folders inferred from files plus explicit fixture directories. */
  folders(): FolderInfo[];
  /** Parsed comments with their owning file attached. */
  comments(): ProjectComment[];
  /** Workspace package ownership and dependency graph. */
  workspace(): WorkspaceGraph;
  /** Validate files, folders, imports, and named boundaries against a tree definition. */
  tree(definition: TreeDefinition): Finding[];
  /** Build a finding not tied to a specific `ProjectFile` helper. */
  report(input: ReportInput): Finding;
  /** Record a commit-time clarification gate without emitting a normal finding. */
  commitGate(input: CommitGateInput): CommitGate;
};

export type ValidatorRuntime = {
  rootDir: string;
  paths: ContextPaths;
  decisions: {
    all: Decision[];
    byId(id: string): Decision | undefined;
    byTopic(topic: string): Decision[];
  };
  matches(file: string, globs: string[]): boolean;
  globs: {
    matches(file: string, patterns: string[]): boolean;
    explain(file: string, patterns: string[]): PatternExplanation[];
  };
  naming: {
    isPascalCase(value: string): boolean;
    isCamelCase(value: string): boolean;
    isKebabCase(value: string): boolean;
    isSnakeCase(value: string): boolean;
    isScreamingSnakeCase(value: string): boolean;
  };
};

export type ValidatorArgs = {
  /** Project data and helper APIs for the current validation run. */
  ctx: ValidationContext;
  /** Stable runtime utilities, loaded decisions, paths, glob helpers, and naming helpers. */
  runtime: ValidatorRuntime;
};

export type ValidatorSummaryInput = {
  id: string;
  topics: string[];
  applies: string[];
  severity: Severity;
  scope: ValidatorScope;
  facts: FactKind[];
  decisionIds: string[];
  docs: string[];
};

export type ValidatorSummary = string | ((definition: ValidatorSummaryInput) => string);

export type ValidatorVisual = {
  kind: "tree";
  title?: string;
  definition: TreeDefinition;
};

export type ValidatorDefinition = {
  /** Stable rule id used in findings, fixtures, filters, baselines, and docs backrefs. */
  id: string;
  topics?: string[];
  /** Glob scopes where this validator applies. */
  applies?: string[];
  /** Extra fact-analysis globs when a validator needs context outside target files. */
  analysis?: string[];
  severity?: Severity;
  scope?: ValidatorScope;
  /** Declared fact kinds used by this validator. */
  facts?: FactKind[];
  decisionIds?: string[];
  docs?: string[];
  summary?: ValidatorSummary;
  visuals?: ValidatorVisual[];
  /** Validator body. Return findings; use `ctx.report()` or `file.report()` to preserve typing. */
  validate?(args: ValidatorArgs): Finding[] | Promise<Finding[]>;
  /** Nested validators inherit parent metadata and scope restrictions. */
  validators?: ValidatorDefinition[];
};

export type ValidatorFactoryBaseOptions = {
  id: string;
  topics: string[];
  severity: Severity;
  decisionIds?: string[];
  docs?: string[];
  summary?: ValidatorSummary;
};

export type ValidatorFactory<TOptions extends Record<string, unknown> = Record<string, never>> = (
  options: ValidatorFactoryBaseOptions & TOptions,
) => ValidatorDefinition;

export type Validator = {
  id: string;
  topics: string[];
  appliesScopes: string[][];
  analysisGlobs: string[];
  severity: Severity;
  scope: ValidatorScope;
  facts: FactKind[];
  decisionIds: string[];
  docs: string[];
  summary?: string;
  visuals: ValidatorVisual[];
  validate(args: ValidatorArgs): Finding[] | Promise<Finding[]>;
};
