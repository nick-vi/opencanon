import type { Finding, ValidatorDefinition } from "@opencanon/core";

export const StudioFixtureCase = {
  Valid: "valid",
  Invalid: "invalid",
} as const;
export type StudioFixtureCase = (typeof StudioFixtureCase)[keyof typeof StudioFixtureCase];

export const StudioFieldKind = {
  Boolean: "boolean",
  Lines: "lines",
  Number: "number",
  RegexLines: "regex-lines",
  Select: "select",
  Text: "text",
  Textarea: "textarea",
} as const;
export type StudioFieldKind = (typeof StudioFieldKind)[keyof typeof StudioFieldKind];

export const StudioSeverity = {
  Error: "error",
  Warning: "warning",
} as const;

export const StudioFixSafety = {
  Manual: "manual",
} as const;

export const StudioTopic = {
  Comments: "comments",
  FolderStructure: "folder-structure",
  Hygiene: "hygiene",
  Imports: "imports",
  QualityGates: "quality-gates",
  Testing: "testing",
  TypePatterns: "type-patterns",
} as const;

export const StudioFactoryId = {
  FileNames: "fileNames",
  NoBypassComments: "noBypassComments",
  NoCommentMatches: "noCommentMatches",
  NoDeepRelativeImports: "noDeepRelativeImports",
  NoFolderNames: "noFolderNames",
  NoForbiddenCalls: "noForbiddenCalls",
  NoHeaderComments: "noHeaderComments",
  NoImports: "noImports",
  NoNativeEnums: "noNativeEnums",
  RequiredFileSibling: "requiredFileSibling",
} as const;
export type StudioFactoryId = (typeof StudioFactoryId)[keyof typeof StudioFactoryId];

export const StudioOption = {
  Allow: "allow",
  AllowNames: "allowNames",
  Calls: "calls",
  DecisionIds: "decisionIds",
  Docs: "docs",
  FixDescription: "fixDescription",
  From: "from",
  HeaderLines: "headerLines",
  Id: "id",
  In: "in",
  MaxDepth: "maxDepth",
  Message: "message",
  Names: "names",
  Patterns: "patterns",
  ReasonPatterns: "reasonPatterns",
  RequireReason: "requireReason",
  SafeFix: "safeFix",
  Severity: "severity",
  Sibling: "sibling",
  Suffix: "suffix",
  To: "to",
  Topics: "topics",
} as const;
export type StudioOption = (typeof StudioOption)[keyof typeof StudioOption];

export const SourceExtensionPattern = /\.(ts|tsx|js|jsx|py|rs|svelte|css|scss|sass|less|json|md|markdown)$/;
export const TextEncoding = {
  Utf8: "utf8",
} as const;

export const StudioLabel = {
  AppliesTo: "Applies to",
} as const;

export const StudioPattern = {
  PackageTypeScriptSources: "packages/*/src/**/*.{ts,tsx}",
  SourceCommentFiles: "src/**/*.{ts,tsx,py}",
  TestCommentFiles: "tests/**/*.{ts,tsx,py}",
  TestTypeScriptSources: "tests/**/*.{ts,tsx}",
  TypeScriptSources: "src/**/*.{ts,tsx}",
} as const;

export const StudioFixturePath = {
  DbClient: "src/db/client.ts",
  ExampleTs: "src/example.ts",
  ServiceCompany: "src/services/company.ts",
} as const;

export const StudioFixtureContent = {
  CompanyService: "export const companyService = {};\n",
  Current: "export const current = true;\n",
  DbClient: "export const db = {};\n",
} as const;

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

export type StudioFixtureSet = Record<StudioFixtureCase, StudioFixtureFile[]>;

export type StudioFactoryDescriptor = {
  id: StudioFactoryId;
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
  fixtureCases: StudioFixtureCase[];
};

export type StudioPreview = {
  validatorId: string;
  validatorPath: string;
  indexPath: string;
  importName: string;
  source: string;
};

export type StudioFixtureRunCase = {
  case: StudioFixtureCase;
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

export type StudioRequest = {
  factoryId: StudioFactoryId;
  options: Record<string, unknown>;
  fixtures: StudioFixtureSet;
};

export type StudioFactory = StudioFactoryDescriptor & {
  create(options: Record<string, unknown>): ValidatorDefinition;
  sourceFields: StudioOption[];
};

