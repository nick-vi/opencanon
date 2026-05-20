export const StudioClassName = {
  Active: "active",
  Field: "studioField",
  FieldWide: "studioFieldWide",
  FixtureInvalid: "studioFixtureInvalid",
  FixtureValid: "studioFixtureValid",
  ResultFailed: "failed",
  ResultPassed: "passed",
  Section: "studioSection",
  SectionHead: "studioSectionHead",
} as const;

export const StudioFieldKind = {
  Boolean: "boolean",
  Lines: "lines",
  Number: "number",
  RegexLines: "regex-lines",
  Select: "select",
  Text: "text",
  Textarea: "textarea",
} as const;

export const StudioFixtureCase = {
  Valid: "valid",
  Invalid: "invalid",
} as const;

export const StudioQueryKey = {
  Factories: "studio.factories",
  Snapshot: "snapshot",
  Validators: "studio.validators",
} as const;

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

export const StudioSeverity = {
  Error: "error",
  Warning: "warning",
} as const;
export type StudioSeverity = (typeof StudioSeverity)[keyof typeof StudioSeverity];

export const StudioSeverityMeta: Record<StudioSeverity, { label: string; detail: string }> = {
  [StudioSeverity.Warning]: { label: "Warning", detail: "non-blocking" },
  [StudioSeverity.Error]: { label: "Error", detail: "blocking" },
};

export const StudioPattern = {
  PackageTypeScriptSources: "packages/*/src/**/*.{ts,tsx}",
  TestTypeScriptSources: "tests/**/*.{ts,tsx}",
  TypeScriptSources: "src/**/*.{ts,tsx}",
} as const;

export const StudioTopic = {
  FolderStructure: "folder-structure",
  Imports: "imports",
  Testing: "testing",
  TypePatterns: "type-patterns",
} as const;

export const StudioFieldGroup = {
  Finding: "finding",
  Identity: "identity",
  Rule: "rule",
  Scope: "scope",
} as const;

export const StudioFieldGroups: Array<{ id: string; label: string; keys: StudioOption[] }> = [
  {
    id: StudioFieldGroup.Identity,
    label: "Identity",
    keys: [StudioOption.Id, StudioOption.Topics, StudioOption.Severity, StudioOption.DecisionIds, StudioOption.Docs],
  },
  {
    id: StudioFieldGroup.Scope,
    label: "Scope",
    keys: [StudioOption.In, StudioOption.From, StudioOption.To],
  },
  {
    id: StudioFieldGroup.Rule,
    label: "Rule",
    keys: [
      StudioOption.Calls,
      StudioOption.Patterns,
      StudioOption.Suffix,
      StudioOption.AllowNames,
      StudioOption.Names,
      StudioOption.MaxDepth,
      StudioOption.HeaderLines,
      StudioOption.Sibling,
      StudioOption.SafeFix,
      StudioOption.Allow,
      StudioOption.RequireReason,
      StudioOption.ReasonPatterns,
    ],
  },
  {
    id: StudioFieldGroup.Finding,
    label: "Finding",
    keys: [StudioOption.Message, StudioOption.FixDescription],
  },
] as const;

export const StudioLinePresets: Partial<Record<StudioOption, string[]>> = {
  [StudioOption.Allow]: ["^SPDX-License-Identifier:", "^@license\\b", "^!\\/usr\\/bin\\/env\\b"],
  [StudioOption.AllowNames]: ["index.ts", "index.tsx", "README.md"],
  [StudioOption.DecisionIds]: ["import-boundaries-current", "const-object-enums", "folder-structure-current"],
  [StudioOption.Docs]: ["docs/opencanon/canon/architecture.md#imports", "docs/opencanon/decisions.json#import-boundaries-current"],
  [StudioOption.From]: [StudioPattern.TypeScriptSources, StudioPattern.PackageTypeScriptSources, StudioPattern.TestTypeScriptSources],
  [StudioOption.In]: [StudioPattern.TypeScriptSources, StudioPattern.PackageTypeScriptSources, StudioPattern.TestTypeScriptSources],
  [StudioOption.Names]: ["misc", "helpers", "common", "temp"],
  [StudioOption.ReasonPatterns]: ["OPENCANON-EXCEPTION-[0-9]+", "[A-Z]+-[0-9]+"],
  [StudioOption.Suffix]: [".service.ts", ".service.tsx", ".test.ts", ".spec.ts"],
  [StudioOption.To]: ["src/db/client.ts", "**/db/client", "@internal/*"],
  [StudioOption.Topics]: [StudioTopic.Imports, StudioTopic.FolderStructure, StudioTopic.TypePatterns, StudioTopic.Testing],
};

export type StudioForm = Record<string, string | boolean>;
