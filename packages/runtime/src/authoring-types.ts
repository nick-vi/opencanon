import type { Convention, Finding } from "@opencanon/core";

export const AuthoringFixtureCase = {
  Valid: "valid",
  Invalid: "invalid",
} as const;
export type AuthoringFixtureCase = (typeof AuthoringFixtureCase)[keyof typeof AuthoringFixtureCase];

export const AuthoringFieldKind = {
  Boolean: "boolean",
  Lines: "lines",
  Number: "number",
  RegexLines: "regex-lines",
  Select: "select",
  Text: "text",
  Textarea: "textarea",
} as const;
export type AuthoringFieldKind = (typeof AuthoringFieldKind)[keyof typeof AuthoringFieldKind];

export const AuthoringSeverity = {
  Error: "error",
  Warning: "warning",
} as const;

export const AuthoringFixSafety = {
  Manual: "manual",
} as const;

export const AuthoringTopic = {
  Comments: "comments",
  FolderStructure: "folder-structure",
  Hygiene: "hygiene",
  Imports: "imports",
  QualityGates: "quality-gates",
  Testing: "testing",
  TypePatterns: "type-patterns",
} as const;

export const AuthoringFactoryId = {
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
export type AuthoringFactoryId = (typeof AuthoringFactoryId)[keyof typeof AuthoringFactoryId];

export const AuthoringOption = {
  Allow: "allow",
  AllowNames: "allowNames",
  Calls: "calls",
  Related: "related",
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
export type AuthoringOption = (typeof AuthoringOption)[keyof typeof AuthoringOption];

export const TextEncoding = {
  Utf8: "utf8",
} as const;

export const AuthoringLabel = {
  AppliesTo: "Applies to",
} as const;

export const AuthoringPattern = {
  PackageTypeScriptSources: "packages/*/src/**/*.{ts,tsx}",
  SourceCommentFiles: "src/**/*.{ts,tsx,py}",
  TestCommentFiles: "tests/**/*.{ts,tsx,py}",
  TestTypeScriptSources: "tests/**/*.{ts,tsx}",
  TypeScriptSources: "src/**/*.{ts,tsx}",
} as const;

export const AuthoringFixturePath = {
  DbClient: "src/db/client.ts",
  ExampleTs: "src/example.ts",
  ServiceCompany: "src/services/company.ts",
} as const;

export const AuthoringFixtureContent = {
  CompanyService: "export const companyService = {};\n",
  Current: "export const current = true;\n",
  DbClient: "export const db = {};\n",
} as const;

export type AuthoringFieldDescriptor = {
  key: string;
  label: string;
  kind: AuthoringFieldKind;
  required?: boolean;
  options?: string[];
  placeholder?: string;
};

export type AuthoringFixtureFile = {
  path: string;
  content: string;
};

export type AuthoringFixtureSet = Record<AuthoringFixtureCase, AuthoringFixtureFile[]>;

export type AuthoringFactoryDescriptor = {
  id: AuthoringFactoryId;
  label: string;
  summary: string;
  fields: AuthoringFieldDescriptor[];
  defaults: Record<string, unknown>;
  fixtures: AuthoringFixtureSet;
};

export type AuthoringValidatorSummary = {
  id: string;
  severity: string;
  scope: string;
  topics: string[];
  sourcePath?: string;
  fixtureCases: AuthoringFixtureCase[];
};

export type AuthoringPreview = {
  validatorId: string;
  validatorPath: string;
  indexPath: string;
  importName: string;
  source: string;
};

export type AuthoringFixtureRunCase = {
  case: AuthoringFixtureCase;
  passed: boolean;
  findings: Finding[];
  details: string[];
};

export type AuthoringFixtureRun = {
  passed: boolean;
  cases: AuthoringFixtureRunCase[];
};

export type AuthoringApplyResult = {
  preview: AuthoringPreview;
  run: AuthoringFixtureRun;
};

export type AuthoringRequest = {
  factoryId: AuthoringFactoryId;
  options: Record<string, unknown>;
  fixtures: AuthoringFixtureSet;
};

export type AuthoringFactory = AuthoringFactoryDescriptor & {
  create(options: Record<string, unknown>): Convention;
  sourceFields: AuthoringOption[];
};
