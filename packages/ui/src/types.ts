export type ApiResponse<T> = { ok: true; data: T } | { ok: false; diagnostics: Array<{ message: string; code?: string }> };

export type DaemonHealthDto = {
  status: string;
  schemaVersion?: number;
  startedAt?: string;
  engine?: {
    engineVersion: string;
    napiVersion: string;
    schemaVersion: number;
  };
  watcher?: {
    running: boolean;
    bufferedEvents: number;
    stale: boolean;
    reason?: string;
  };
};

export type DaemonStateDto = {
  health: DaemonHealthDto;
  files: number;
  findings: number;
  staleFiles: number;
  cacheHits: number;
  cacheMisses: number;
};

export type Snapshot = {
  health: DaemonHealthDto;
  state: DaemonStateDto;
  files: string[];
  decisions: DecisionSummary[];
  docs: DocSnippetSummary[];
  graph: {
    rootDir?: string;
    graphHash: string;
    importEdges: Array<{
      from: string;
      source: string;
      to?: string;
      resolution: string;
      fromPackage?: string;
      toPackage?: string;
    }>;
  };
  facts: CodeFileFacts[];
  findings: Finding[];
  impactSurfaces: ImpactSurfaceSummary[];
  validators: Array<{
    id: string;
    severity: string;
    scope: string;
    facts: string[];
    topics: string[];
    appliesScopes: string[][];
    decisionIds: string[];
    docs: string[];
    summary?: string;
    visuals: Array<{ kind: "tree"; title?: string; definition?: unknown }>;
  }>;
};

export type ValidatorSummary = Snapshot["validators"][number];
export type ImportEdge = Snapshot["graph"]["importEdges"][number];

export type ImportFact = {
  line: number;
  column?: number;
  source: string;
  specifiers: string[];
  kind: "import" | "export" | "dynamic";
  resolution: "relative" | "alias" | "workspace" | "external" | "unresolved";
  resolvedPath?: string;
  fromPackage?: string;
  toPackage?: string;
};

export type ExportFact = {
  line: number;
  column?: number;
  name: string;
  kind: "function" | "class" | "type" | "interface" | "const" | "let" | "var" | "enum" | "default" | "unknown";
};

export type SymbolFact = {
  line: number;
  column?: number;
  name: string;
  kind: "function" | "class" | "method" | "variable" | "type" | "interface" | "enum" | "property" | "unknown";
  exported: boolean;
  endLine?: number;
};

export type CodeFileFacts = {
  path: string;
  imports: ImportFact[];
  exports: ExportFact[];
  symbols: SymbolFact[];
};

export type Finding = {
  id: string;
  kind?: string;
  severity: "error" | "warning" | "info";
  validatorId?: string;
  title?: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  docs?: string[];
  decisionIds?: string[];
  fix?: { type: string; description: string };
};

export type DecisionSummary = {
  id: string;
  date: string;
  status: string;
  title: string;
  topics: string[];
  applies: string[];
  summary: string;
  validatorIds?: string[];
  docs?: string[];
};

export type ImpactSurfaceSummary = {
  id: string;
  title?: string;
  applies: string[];
  owns?: string[];
  dependsOn?: string[];
  downstream?: string[];
  risks?: string[];
  docs?: string[];
  decisionIds?: string[];
  proposed?: boolean;
  changePolicy?: {
    requiresTests?: string[];
    requiresDocs?: string[];
    requiresDecision?: boolean;
    reviewers?: string[];
  };
};

export type DocSnippetSummary = {
  source: string;
  path: string;
  slug: string;
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  decisionIds: string[];
  body: string;
  contentHash: string;
};

export type ProjectSummary = {
  id: string;
  rootDir: string;
  url: string;
  status: "running" | "unhealthy" | "stale" | "current";
  pid?: number;
  port?: number;
  files?: number;
  findings?: number;
};

export type ProjectConfig = {
  docsDir: string;
  decisionsPath: string;
  validatorsPath: string;
  fixturesDir: string;
  impactSurfacesPath: string;
  proposedImpactNotesPath: string;
  baselinePath: string;
  cacheDir: string;
  projectFilePatterns: string[];
  ignore: string[];
  entrypoints: string[];
  publicSurfaces: string[];
  generated: string[];
  externalTools: Record<string, ExternalToolConfig>;
  requiredPackageScripts: string[];
  fileDiscovery: "git" | "filesystem";
  maxFiles: number;
  maxFileSizeKb: number;
};

export type ExternalToolConfig =
  | string
  | string[]
  | {
      command: string | string[];
      required?: boolean;
      missingSeverity?: "error" | "warning" | "ignore";
      versionArgs?: string[];
      timeoutMs?: number;
    };

export type ProjectSettings = {
  rootDir: string;
  configPath: string;
  hasConfig: boolean;
  defaults: ProjectConfig;
  effective: ProjectConfig;
  overrides: Partial<ProjectConfig>;
  diagnostics: string[];
};

export type StudioFieldKind = "boolean" | "lines" | "number" | "regex-lines" | "select" | "text" | "textarea";

export type StudioFieldDescriptor = {
  key: string;
  label: string;
  kind: StudioFieldKind;
  required?: boolean;
  options?: string[];
  placeholder?: string;
};

export type StudioFixtureFile = {
  path: string;
  content: string;
};

export type StudioFixtureSet = {
  valid: StudioFixtureFile[];
  invalid: StudioFixtureFile[];
};

export type StudioFactoryDescriptor = {
  id: string;
  label: string;
  summary: string;
  fields: StudioFieldDescriptor[];
  defaults: Record<string, unknown>;
  fixtures: StudioFixtureSet;
};

export type StudioValidatorSummary = {
  id: string;
  severity: string;
  scope: string;
  topics: string[];
  sourcePath?: string;
  fixtureCases: Array<"valid" | "invalid">;
};

export type StudioRequest = {
  factoryId: string;
  options: Record<string, unknown>;
  fixtures: StudioFixtureSet;
};

export type StudioPreview = {
  validatorId: string;
  validatorPath: string;
  indexPath: string;
  importName: string;
  source: string;
};

export type StudioFixtureRunCase = {
  case: "valid" | "invalid";
  passed: boolean;
  findings: Finding[];
  details: string[];
};

export type StudioFixtureRun = {
  passed: boolean;
  cases: StudioFixtureRunCase[];
};

export type StudioApplyResult = {
  preview: StudioPreview;
  run: StudioFixtureRun;
};

export type TreeEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
  indexed: boolean;
  findingCount: number;
  language?: string;
};

export type TreeResponse = { path: string; entries: TreeEntry[] };

export type TreeScope = "all" | "canon";

export type FileResponse = {
  path: string;
  language: string;
  bytes: number;
  content: string;
};

export type GitCommit = {
  hash: string;
  fullHash: string;
  date: string;
  author: string;
  subject: string;
};

export type GitFileHistory = {
  file: string;
  commits: GitCommit[];
  diagnostics: string[];
};

export type GitHistoryResponse = {
  gitRoot: string | null;
  histories: GitFileHistory[];
  diagnostics: string[];
};

export type GitDiffResponse = {
  gitRoot: string | null;
  file: string;
  commit: string;
  beforeContent: string;
  afterContent: string;
  diagnostics: string[];
};

export type DaemonStreamEvent = {
  type: "snapshot" | "indexing" | "error";
  timestamp: string;
  summary: string;
  snapshot?: Snapshot;
};
