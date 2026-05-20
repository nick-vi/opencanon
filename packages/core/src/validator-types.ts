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
  safety: FixSafety;
  description: string;
  command?: string;
  edits?: TextEdit[];
};

export type Finding = {
  validatorId: string;
  severity: Severity;
  file: string;
  line: number;
  column?: number;
  message: string;
  fix?: FindingFix;
  docs?: string[];
  decisionIds?: string[];
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

export type GraphApi = {
  symbols(): ProjectSymbolFact[];
  references(): ProjectReferenceFact[];
  callers(symbol: string | ProjectSymbolFact): ProjectGraphEdge[];
  callees(symbol: string | ProjectSymbolFact): ProjectGraphEdge[];
  impact(symbol: string | ProjectSymbolFact): ProjectGraphEdge[];
};

export type FileRead = {
  path: string;
  file?: ProjectFile;
  text?: string;
  diagnostics: string[];
};

export type JsonRead<T = unknown> = {
  path: string;
  file?: ProjectFile;
  data?: T;
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
  path: string;
  absolutePath: string;
  text: string;
  lines: string[];
  extension: string;
  language: "typescript" | "svelte" | "python" | "json" | "markdown" | "text";
  has(pattern: RegExp | string): boolean;
  find(pattern: RegExp | string): TextMatch[];
  json<T = unknown>(): JsonRead<T>;
  lineAt(line: number): string;
  matches(glob: string): boolean;
  comments(): CommentInfo[];
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
  files: ProjectFile[];
  targetFiles: ProjectFile[];
  project: boolean;
  facts: FactsApi;
  graph: GraphApi;
  impact: ImpactApi;
  baseline: BaselineApi;
  file(path: string): ProjectFile | undefined;
  byGlob(patterns: string[]): ProjectFile[];
  text(path: string): FileRead;
  json<T = unknown>(path: string): JsonRead<T>;
  jsonFiles<T = unknown>(patterns: string[]): JsonRead<T>[];
  imports(): ImportEdge[];
  folders(): FolderInfo[];
  comments(): ProjectComment[];
  workspace(): WorkspaceGraph;
  tree(definition: TreeDefinition): Finding[];
  report(input: ReportInput): Finding;
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
  ctx: ValidationContext;
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
  id: string;
  topics?: string[];
  applies?: string[];
  severity?: Severity;
  scope?: ValidatorScope;
  facts?: FactKind[];
  decisionIds?: string[];
  docs?: string[];
  summary?: ValidatorSummary;
  visuals?: ValidatorVisual[];
  validate?(args: ValidatorArgs): Finding[] | Promise<Finding[]>;
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
  severity: Severity;
  scope: ValidatorScope;
  facts: FactKind[];
  decisionIds: string[];
  docs: string[];
  summary?: string;
  visuals: ValidatorVisual[];
  validate(args: ValidatorArgs): Finding[] | Promise<Finding[]>;
};
