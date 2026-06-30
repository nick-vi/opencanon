import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createOpenCanonDiagnostic,
  createPaths,
  createRuntime,
  createValidationContextFromFixture,
  loadProjectContext,
  relative,
  resolveValidators,
  validateFindings,
  writeAtomicTextFileSync,
  isSupportedSourceFile,
  conventionToValidator,
  type Validator,
} from "@opencanon/core";
import {
  fileNames,
  noBypassComments,
  noCommentMatches,
  noDeepRelativeImports,
  noFolderNames,
  noForbiddenCalls,
  noImports,
  noHeaderComments,
  noNativeEnums,
  requiredFileSibling,
} from "@opencanon/validators";

import {
  AuthoringFactoryId,
  AuthoringFixtureCase,
  AuthoringFixtureContent,
  AuthoringFixturePath,
  AuthoringFieldKind,
  AuthoringFixSafety,
  AuthoringLabel,
  AuthoringOption,
  AuthoringPattern,
  AuthoringSeverity,
  AuthoringTopic,
  TextEncoding,
} from "./authoring-types.ts";
import type {
  AuthoringApplyResult,
  AuthoringFactory,
  AuthoringFactoryDescriptor,
  AuthoringFieldDescriptor,
  AuthoringFixtureFile,
  AuthoringFixtureRun,
  AuthoringFixtureRunCase,
  AuthoringFixtureSet,
  AuthoringOption as AuthoringOptionValue,
  AuthoringPreview,
  AuthoringRequest,
  AuthoringValidatorSummary,
} from "./authoring-types.ts";
const commonFields: AuthoringFieldDescriptor[] = [
  { key: AuthoringOption.Id, label: "Convention id", kind: AuthoringFieldKind.Text, required: true, placeholder: "no-unsafe-db-imports" },
  { key: AuthoringOption.Topics, label: "Topics", kind: AuthoringFieldKind.Lines, required: true, placeholder: "imports" },
  { key: AuthoringOption.Severity, label: "Severity", kind: AuthoringFieldKind.Select, required: true, options: [AuthoringSeverity.Warning, AuthoringSeverity.Error] },
  { key: AuthoringOption.Related, label: "Related conventions", kind: AuthoringFieldKind.Lines },
  { key: AuthoringOption.Docs, label: "Docs", kind: AuthoringFieldKind.Lines },
  { key: AuthoringOption.Message, label: "Finding message", kind: AuthoringFieldKind.Textarea, required: true },
  { key: AuthoringOption.FixDescription, label: "Fix description", kind: AuthoringFieldKind.Textarea },
];

const authoringFactories: AuthoringFactory[] = [
  {
    id: AuthoringFactoryId.NoForbiddenCalls,
    label: "Forbidden calls",
    summary: "Find calls matching one or more regular expressions.",
    fields: [
      ...commonFields,
      { key: AuthoringOption.In, label: AuthoringLabel.AppliesTo, kind: AuthoringFieldKind.Lines, required: true },
      { key: AuthoringOption.Calls, label: "Call patterns", kind: AuthoringFieldKind.RegexLines, required: true },
    ],
    defaults: {
      [AuthoringOption.Id]: "no-forbidden-calls",
      [AuthoringOption.Topics]: [AuthoringTopic.Hygiene],
      [AuthoringOption.Severity]: AuthoringSeverity.Warning,
      [AuthoringOption.In]: [AuthoringPattern.TypeScriptSources, AuthoringPattern.PackageTypeScriptSources],
      [AuthoringOption.Calls]: ["eval\\("],
      [AuthoringOption.Message]: "Forbidden API call.",
      [AuthoringOption.FixDescription]: "Replace this call with an approved local abstraction.",
    },
    fixtures: {
      valid: [{ path: AuthoringFixturePath.ExampleTs, content: "export function run(input: string) {\n  return input.trim();\n}\n" }],
      invalid: [{ path: AuthoringFixturePath.ExampleTs, content: "export function run(input: string) {\n  return eval(input);\n}\n" }],
    },
    sourceFields: [
      AuthoringOption.Id,
      AuthoringOption.Topics,
      AuthoringOption.In,
      AuthoringOption.Severity,
      AuthoringOption.Related,
      AuthoringOption.Calls,
      AuthoringOption.Message,
      AuthoringOption.FixDescription,
      AuthoringOption.Docs,
    ],
    create: (options) =>
      noForbiddenCalls({
        ...baseFactoryOptions(options),
        in: stringListOption(options, AuthoringOption.In),
        calls: regexListOption(options, AuthoringOption.Calls),
      }),
  },
  {
    id: AuthoringFactoryId.NoCommentMatches,
    label: "Forbidden comments",
    summary: "Find comments matching one or more regular expressions.",
    fields: [
      ...commonFields,
      { key: AuthoringOption.In, label: AuthoringLabel.AppliesTo, kind: AuthoringFieldKind.Lines, required: true },
      { key: AuthoringOption.Patterns, label: "Comment patterns", kind: AuthoringFieldKind.RegexLines, required: true },
    ],
    defaults: {
      [AuthoringOption.Id]: "no-stale-comments",
      [AuthoringOption.Topics]: [AuthoringTopic.Comments],
      [AuthoringOption.Severity]: AuthoringSeverity.Warning,
      [AuthoringOption.In]: [AuthoringPattern.SourceCommentFiles, AuthoringPattern.TestCommentFiles],
      [AuthoringOption.Patterns]: ["legacy|deprecated|shim"],
      [AuthoringOption.Message]: "Comment describes stale implementation intent.",
      [AuthoringOption.FixDescription]: "Update the code to the current pattern and remove the stale comment.",
    },
    fixtures: {
      valid: [{ path: AuthoringFixturePath.ExampleTs, content: AuthoringFixtureContent.Current }],
      invalid: [{ path: AuthoringFixturePath.ExampleTs, content: `// legacy compatibility path\n${AuthoringFixtureContent.Current}` }],
    },
    sourceFields: [
      AuthoringOption.Id,
      AuthoringOption.Topics,
      AuthoringOption.In,
      AuthoringOption.Severity,
      AuthoringOption.Related,
      AuthoringOption.Patterns,
      AuthoringOption.Message,
      AuthoringOption.FixDescription,
      AuthoringOption.Docs,
    ],
    create: (options) =>
      noCommentMatches({
        ...baseFactoryOptions(options),
        in: stringListOption(options, AuthoringOption.In),
        patterns: regexListOption(options, AuthoringOption.Patterns),
      }),
  },
  {
    id: AuthoringFactoryId.NoHeaderComments,
    label: "Header comments",
    summary: "Deny file-level header or provenance comments before code.",
    fields: [
      ...commonFields,
      { key: AuthoringOption.In, label: AuthoringLabel.AppliesTo, kind: AuthoringFieldKind.Lines, required: true },
      { key: AuthoringOption.HeaderLines, label: "Header scan lines", kind: AuthoringFieldKind.Number, required: true },
      { key: AuthoringOption.Patterns, label: "Header patterns", kind: AuthoringFieldKind.RegexLines },
      { key: AuthoringOption.Allow, label: "Allowed header patterns", kind: AuthoringFieldKind.RegexLines },
    ],
    defaults: {
      [AuthoringOption.Id]: "no-header-comments",
      [AuthoringOption.Topics]: [AuthoringTopic.Comments],
      [AuthoringOption.Severity]: AuthoringSeverity.Warning,
      [AuthoringOption.In]: [AuthoringPattern.SourceCommentFiles, AuthoringPattern.TestCommentFiles],
      [AuthoringOption.HeaderLines]: 12,
      [AuthoringOption.Patterns]: [],
      [AuthoringOption.Allow]: ["^SPDX-License-Identifier:", "^@license\\b", "^!\\/usr\\/bin\\/env\\b"],
      [AuthoringOption.Message]: "File starts with an unapproved header comment.",
      [AuthoringOption.FixDescription]: "Remove the header comment unless it is required license, shebang, or reference metadata.",
    },
    fixtures: {
      valid: [{ path: AuthoringFixturePath.ExampleTs, content: AuthoringFixtureContent.Current }],
      invalid: [{ path: AuthoringFixturePath.ExampleTs, content: `// This file contains shared utility functions.\n${AuthoringFixtureContent.Current}` }],
    },
    sourceFields: [
      AuthoringOption.Id,
      AuthoringOption.Topics,
      AuthoringOption.In,
      AuthoringOption.Severity,
      AuthoringOption.Related,
      AuthoringOption.HeaderLines,
      AuthoringOption.Patterns,
      AuthoringOption.Allow,
      AuthoringOption.Message,
      AuthoringOption.FixDescription,
      AuthoringOption.Docs,
    ],
    create: (options) =>
      noHeaderComments({
        ...baseFactoryOptions(options),
        in: stringListOption(options, AuthoringOption.In),
        maxHeaderLines: numberOption(options, AuthoringOption.HeaderLines, 12),
        patterns: regexListOption(options, AuthoringOption.Patterns),
        allow: regexListOption(options, AuthoringOption.Allow),
      }),
  },
  {
    id: AuthoringFactoryId.NoBypassComments,
    label: "Bypass comments",
    summary: "Deny linter, typechecker, no-verify, and OpenCanon suppression comments.",
    fields: [
      ...commonFields,
      { key: AuthoringOption.In, label: AuthoringLabel.AppliesTo, kind: AuthoringFieldKind.Lines, required: true },
      { key: AuthoringOption.Patterns, label: "Bypass patterns", kind: AuthoringFieldKind.RegexLines },
      { key: AuthoringOption.Allow, label: "Allowed bypass patterns", kind: AuthoringFieldKind.RegexLines },
      { key: AuthoringOption.RequireReason, label: "Allow only with approved reason", kind: AuthoringFieldKind.Boolean },
      { key: AuthoringOption.ReasonPatterns, label: "Required reason patterns", kind: AuthoringFieldKind.RegexLines },
    ],
    defaults: {
      [AuthoringOption.Id]: "no-bypass-comments",
      [AuthoringOption.Topics]: [AuthoringTopic.Comments, AuthoringTopic.QualityGates],
      [AuthoringOption.Severity]: AuthoringSeverity.Error,
      [AuthoringOption.In]: [AuthoringPattern.SourceCommentFiles, AuthoringPattern.TestCommentFiles],
      [AuthoringOption.Patterns]: ["eslint-disable(?:-next-line|-line)?", "@ts-(?:ignore|expect-error|nocheck)", "noqa|type:\\s*ignore|pylint:\\s*disable", "opencanon-(?:disable|ignore|skip)", "no-verify"],
      [AuthoringOption.Allow]: [],
      [AuthoringOption.RequireReason]: false,
      [AuthoringOption.ReasonPatterns]: ["OPENCANON-EXCEPTION-[0-9]+", "[A-Z]+-[0-9]+"],
      [AuthoringOption.Message]: "Bypass comments are not allowed without an approved project policy.",
      [AuthoringOption.FixDescription]: "Remove the bypass comment and fix the underlying issue, or document a project-level exception.",
    },
    fixtures: {
      valid: [{ path: AuthoringFixturePath.ExampleTs, content: AuthoringFixtureContent.Current }],
      invalid: [{ path: AuthoringFixturePath.ExampleTs, content: "// eslint-disable-next-line no-console\nconsole.log(\"debug\");\n" }],
    },
    sourceFields: [
      AuthoringOption.Id,
      AuthoringOption.Topics,
      AuthoringOption.In,
      AuthoringOption.Severity,
      AuthoringOption.Related,
      AuthoringOption.Patterns,
      AuthoringOption.Allow,
      AuthoringOption.RequireReason,
      AuthoringOption.ReasonPatterns,
      AuthoringOption.Message,
      AuthoringOption.FixDescription,
      AuthoringOption.Docs,
    ],
    create: (options) =>
      noBypassComments({
        ...baseFactoryOptions(options),
        in: stringListOption(options, AuthoringOption.In),
        patterns: regexListOption(options, AuthoringOption.Patterns),
        allow: regexListOption(options, AuthoringOption.Allow),
        requireReason: booleanOption(options, AuthoringOption.RequireReason, false),
        reasonPatterns: regexListOption(options, AuthoringOption.ReasonPatterns),
      }),
  },
  {
    id: AuthoringFactoryId.FileNames,
    label: "File names",
    summary: "Require matching file names or suffixes under configured globs.",
    fields: [
      ...commonFields,
      { key: AuthoringOption.In, label: AuthoringLabel.AppliesTo, kind: AuthoringFieldKind.Lines, required: true },
      { key: AuthoringOption.Suffix, label: "Required suffixes", kind: AuthoringFieldKind.Lines, required: true },
      { key: AuthoringOption.AllowNames, label: "Allowed exact names", kind: AuthoringFieldKind.Lines },
    ],
    defaults: {
      [AuthoringOption.Id]: "service-file-names",
      [AuthoringOption.Topics]: [AuthoringTopic.FolderStructure],
      [AuthoringOption.Severity]: AuthoringSeverity.Warning,
      [AuthoringOption.In]: ["src/services/**/*.{ts,tsx}"],
      [AuthoringOption.Suffix]: [".service.ts", ".service.tsx"],
      [AuthoringOption.AllowNames]: ["index.ts", "index.tsx"],
      [AuthoringOption.Message]: "File name does not match the required naming pattern.",
      [AuthoringOption.FixDescription]: "Rename the file and update imports.",
    },
    fixtures: {
      valid: [{ path: "src/services/company.service.ts", content: AuthoringFixtureContent.CompanyService }],
      invalid: [{ path: AuthoringFixturePath.ServiceCompany, content: AuthoringFixtureContent.CompanyService }],
    },
    sourceFields: [
      AuthoringOption.Id,
      AuthoringOption.Topics,
      AuthoringOption.In,
      AuthoringOption.Severity,
      AuthoringOption.Related,
      AuthoringOption.Suffix,
      AuthoringOption.AllowNames,
      AuthoringOption.Message,
      AuthoringOption.FixDescription,
      AuthoringOption.Docs,
    ],
    create: (options) =>
      fileNames({
        ...baseFactoryOptions(options),
        in: stringListOption(options, AuthoringOption.In),
        suffix: stringListOption(options, AuthoringOption.Suffix),
        allowNames: stringListOption(options, AuthoringOption.AllowNames),
      }),
  },
  {
    id: AuthoringFactoryId.NoImports,
    label: "Import boundary",
    summary: "Deny imports from one set of files to another set of files or packages.",
    fields: [
      ...commonFields,
      { key: AuthoringOption.From, label: "From", kind: AuthoringFieldKind.Lines, required: true },
      { key: AuthoringOption.To, label: "Denied imports", kind: AuthoringFieldKind.Lines, required: true },
    ],
    defaults: {
      [AuthoringOption.Id]: "no-layer-imports",
      [AuthoringOption.Topics]: [AuthoringTopic.Imports],
      [AuthoringOption.Severity]: AuthoringSeverity.Error,
      [AuthoringOption.From]: ["src/services/**/*.{ts,tsx}"],
      [AuthoringOption.To]: [AuthoringFixturePath.DbClient, "**/db/client"],
      [AuthoringOption.Message]: "Import crosses a denied ownership boundary.",
      [AuthoringOption.FixDescription]: "Move the dependency behind an approved facade.",
    },
    fixtures: {
      valid: [
        { path: AuthoringFixturePath.ServiceCompany, content: AuthoringFixtureContent.CompanyService },
        { path: AuthoringFixturePath.DbClient, content: AuthoringFixtureContent.DbClient },
      ],
      invalid: [
        { path: AuthoringFixturePath.ServiceCompany, content: "import { db } from \"../db/client\";\nexport const companyService = db;\n" },
        { path: AuthoringFixturePath.DbClient, content: AuthoringFixtureContent.DbClient },
      ],
    },
    sourceFields: [
      AuthoringOption.Id,
      AuthoringOption.Topics,
      AuthoringOption.From,
      AuthoringOption.To,
      AuthoringOption.Severity,
      AuthoringOption.Related,
      AuthoringOption.Message,
      AuthoringOption.FixDescription,
      AuthoringOption.Docs,
    ],
    create: (options) =>
      noImports({
        ...baseFactoryOptions(options),
        from: stringListOption(options, AuthoringOption.From),
        to: stringListOption(options, AuthoringOption.To),
      }),
  },
  {
    id: AuthoringFactoryId.NoNativeEnums,
    label: "Native enums",
    summary: "Require const-object enum patterns instead of TypeScript enums.",
    fields: [
      { key: AuthoringOption.Id, label: "Convention id", kind: AuthoringFieldKind.Text, required: true },
      { key: AuthoringOption.Topics, label: "Topics", kind: AuthoringFieldKind.Lines, required: true },
      { key: AuthoringOption.Severity, label: "Severity", kind: AuthoringFieldKind.Select, required: true, options: [AuthoringSeverity.Warning, AuthoringSeverity.Error] },
      { key: AuthoringOption.Related, label: "Related conventions", kind: AuthoringFieldKind.Lines },
      { key: AuthoringOption.Docs, label: "Docs", kind: AuthoringFieldKind.Lines },
      { key: AuthoringOption.In, label: AuthoringLabel.AppliesTo, kind: AuthoringFieldKind.Lines, required: true },
      { key: AuthoringOption.Message, label: "Finding message", kind: AuthoringFieldKind.Textarea },
      { key: AuthoringOption.SafeFix, label: "Enable safe string-enum fix", kind: AuthoringFieldKind.Boolean },
    ],
    defaults: {
      [AuthoringOption.Id]: "no-native-enums",
      [AuthoringOption.Topics]: [AuthoringTopic.TypePatterns],
      [AuthoringOption.Severity]: AuthoringSeverity.Error,
      [AuthoringOption.In]: [AuthoringPattern.TypeScriptSources],
      [AuthoringOption.SafeFix]: true,
      [AuthoringOption.Message]: "Native TypeScript enums are not allowed.",
    },
    fixtures: {
      valid: [{ path: "src/status.ts", content: "export const Status = { ACTIVE: \"active\" } as const;\nexport type Status = (typeof Status)[keyof typeof Status];\n" }],
      invalid: [{ path: "src/status.ts", content: "export enum Status {\n  ACTIVE = \"active\",\n}\n" }],
    },
    sourceFields: [
      AuthoringOption.Id,
      AuthoringOption.Topics,
      AuthoringOption.In,
      AuthoringOption.Severity,
      AuthoringOption.Related,
      AuthoringOption.Message,
      AuthoringOption.SafeFix,
      AuthoringOption.Docs,
    ],
    create: (options) =>
      noNativeEnums({
        id: stringOption(options, AuthoringOption.Id),
        topics: stringListOption(options, AuthoringOption.Topics),
        in: stringListOption(options, AuthoringOption.In),
        severity: severityOption(options),
        related: stringListOption(options, AuthoringOption.Related),
        docs: stringListOption(options, AuthoringOption.Docs),
        message: optionalStringOption(options, AuthoringOption.Message),
        safeFix: booleanOption(options, AuthoringOption.SafeFix, true),
      }),
  },
  {
    id: AuthoringFactoryId.NoDeepRelativeImports,
    label: "Relative import depth",
    summary: "Limit how far relative imports may climb.",
    fields: [
      ...commonFields,
      { key: AuthoringOption.In, label: AuthoringLabel.AppliesTo, kind: AuthoringFieldKind.Lines, required: true },
      { key: AuthoringOption.MaxDepth, label: "Max relative depth", kind: AuthoringFieldKind.Number, required: true },
    ],
    defaults: {
      [AuthoringOption.Id]: "no-deep-relative-imports",
      [AuthoringOption.Topics]: [AuthoringTopic.Imports],
      [AuthoringOption.Severity]: AuthoringSeverity.Warning,
      [AuthoringOption.In]: [AuthoringPattern.TypeScriptSources, AuthoringPattern.TestTypeScriptSources],
      [AuthoringOption.MaxDepth]: 1,
      [AuthoringOption.Message]: "Relative import climbs too far across ownership boundaries.",
      [AuthoringOption.FixDescription]: "Use an approved import surface or move the helper closer.",
    },
    fixtures: {
      valid: [
        { path: "src/features/company/view.ts", content: "import { format } from \"./format\";\nexport const view = format;\n" },
        { path: "src/features/company/format.ts", content: "export const format = () => \"company\";\n" },
      ],
      invalid: [
        { path: "src/features/company/nested/view.ts", content: "import { format } from \"../../../shared/format\";\nexport const view = format;\n" },
        { path: "src/shared/format.ts", content: "export const format = () => \"company\";\n" },
      ],
    },
    sourceFields: [
      AuthoringOption.Id,
      AuthoringOption.Topics,
      AuthoringOption.In,
      AuthoringOption.Severity,
      AuthoringOption.Related,
      AuthoringOption.MaxDepth,
      AuthoringOption.Message,
      AuthoringOption.FixDescription,
      AuthoringOption.Docs,
    ],
    create: (options) =>
      noDeepRelativeImports({
        ...baseFactoryOptions(options),
        in: stringListOption(options, AuthoringOption.In),
        maxDepth: numberOption(options, AuthoringOption.MaxDepth, 1),
      }),
  },
  {
    id: AuthoringFactoryId.NoFolderNames,
    label: "Folder names",
    summary: "Deny ambiguous folder names under configured roots.",
    fields: [
      ...commonFields,
      { key: AuthoringOption.In, label: "Roots", kind: AuthoringFieldKind.Lines, required: true },
      { key: AuthoringOption.Names, label: "Denied folder names", kind: AuthoringFieldKind.Lines, required: true },
    ],
    defaults: {
      [AuthoringOption.Id]: "no-ambiguous-folders",
      [AuthoringOption.Topics]: [AuthoringTopic.FolderStructure],
      [AuthoringOption.Severity]: AuthoringSeverity.Warning,
      [AuthoringOption.In]: ["src", "tests", "packages/*/src"],
      [AuthoringOption.Names]: ["misc", "helpers", "common"],
      [AuthoringOption.Message]: "Folder name is too ambiguous for source ownership.",
      [AuthoringOption.FixDescription]: "Move the flow into a responsibility-named folder.",
    },
    fixtures: {
      valid: [{ path: AuthoringFixturePath.ServiceCompany, content: AuthoringFixtureContent.CompanyService }],
      invalid: [{ path: "src/misc/company.ts", content: AuthoringFixtureContent.CompanyService }],
    },
    sourceFields: [
      AuthoringOption.Id,
      AuthoringOption.Topics,
      AuthoringOption.In,
      AuthoringOption.Severity,
      AuthoringOption.Related,
      AuthoringOption.Names,
      AuthoringOption.Message,
      AuthoringOption.FixDescription,
      AuthoringOption.Docs,
    ],
    create: (options) =>
      noFolderNames({
        ...baseFactoryOptions(options),
        in: stringListOption(options, AuthoringOption.In),
        names: stringListOption(options, AuthoringOption.Names),
      }),
  },
  {
    id: AuthoringFactoryId.RequiredFileSibling,
    label: "Required sibling file",
    summary: "Require files matching a glob to have a sibling file.",
    fields: [
      ...commonFields,
      { key: AuthoringOption.In, label: AuthoringLabel.AppliesTo, kind: AuthoringFieldKind.Lines, required: true },
      { key: AuthoringOption.Sibling, label: "Sibling template", kind: AuthoringFieldKind.Text, required: true, placeholder: "{stem}.test.ts" },
    ],
    defaults: {
      [AuthoringOption.Id]: "required-sibling-test",
      [AuthoringOption.Topics]: [AuthoringTopic.Testing],
      [AuthoringOption.Severity]: AuthoringSeverity.Warning,
      [AuthoringOption.In]: ["src/**/*.ts"],
      [AuthoringOption.Sibling]: "{stem}.test.ts",
      [AuthoringOption.Message]: "File is missing a required sibling.",
      [AuthoringOption.FixDescription]: "Add the required sibling file or document why this path is exempt.",
    },
    fixtures: {
      valid: [
        { path: "src/company.ts", content: "export const company = {};\n" },
        { path: "src/company.test.ts", content: "import { company } from \"./company\";\nvoid company;\n" },
      ],
      invalid: [{ path: "src/company.ts", content: "export const company = {};\n" }],
    },
    sourceFields: [
      AuthoringOption.Id,
      AuthoringOption.Topics,
      AuthoringOption.In,
      AuthoringOption.Severity,
      AuthoringOption.Related,
      AuthoringOption.Sibling,
      AuthoringOption.Message,
      AuthoringOption.FixDescription,
      AuthoringOption.Docs,
    ],
    create: (options) =>
      requiredFileSibling({
        ...baseFactoryOptions(options),
        in: stringListOption(options, AuthoringOption.In),
        sibling: stringOption(options, AuthoringOption.Sibling),
      }),
  },
];

export function listAuthoringFactories(): AuthoringFactoryDescriptor[] {
  return authoringFactories.map(({ create: _create, sourceFields: _sourceFields, ...descriptor }) => descriptor);
}

export async function listAuthoringValidators(rootDir: string): Promise<AuthoringValidatorSummary[]> {
  const project = await loadProjectContext(rootDir);
  const sourceMap = discoverValidatorSourceFiles(rootDir, project.paths.conventionsPath);
  return project.validators.map((validator) => ({
    id: validator.id,
    severity: validator.severity,
    scope: validator.scope,
    topics: validator.topics,
    sourcePath: sourceMap.get(validator.id),
    fixtureCases: fixtureCases(project.paths.fixturesDir, validator.id),
  }));
}

export function previewAuthoringValidator(rootDir: string, body: Record<string, unknown>): { ok: true; preview: AuthoringPreview } | { ok: false; diagnostics: unknown[] } {
  const parsed = parseAuthoringRequest(body);
  if (!parsed.ok) return parsed;
  const built = buildAuthoringValidator(rootDir, parsed.request);
  if (!built.ok) return built;
  return { ok: true, preview: built.preview };
}

export async function runAuthoringValidatorFixtures(
  rootDir: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; run: AuthoringFixtureRun } | { ok: false; diagnostics: unknown[] }> {
  const parsed = parseAuthoringRequest(body);
  if (!parsed.ok) return parsed;
  const built = buildAuthoringValidator(rootDir, parsed.request);
  if (!built.ok) return built;
  return { ok: true, run: await runFixtures(rootDir, built.validator, parsed.request.fixtures) };
}

export async function applyAuthoringValidator(
  rootDir: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; result: AuthoringApplyResult } | { ok: false; diagnostics: unknown[] }> {
  const parsed = parseAuthoringRequest(body);
  if (!parsed.ok) return parsed;
  const built = buildAuthoringValidator(rootDir, parsed.request);
  if (!built.ok) return built;
  const run = await runFixtures(rootDir, built.validator, parsed.request.fixtures);
  if (!run.passed) return { ok: false, diagnostics: [authoringDiagnostic("Fixtures must pass before applying the validator.")] };

  const paths = createPaths(rootDir);
  const absoluteValidatorPath = path.join(rootDir, built.preview.validatorPath);
  if (existsSync(absoluteValidatorPath)) {
    return { ok: false, diagnostics: [authoringDiagnostic(`Convention file already exists: ${built.preview.validatorPath}.`)] };
  }
  const indexUpdate = updateValidatorIndex(paths.conventionsPath, built.preview.importName, `./${path.posix.basename(built.preview.validatorPath)}`);
  if (!indexUpdate.ok) return indexUpdate;

  writeAtomicTextFileSync(absoluteValidatorPath, built.preview.source);
  writeFixtureSet(paths.fixturesDir, built.preview.validatorId, parsed.request.fixtures);
  writeAtomicTextFileSync(paths.conventionsPath, indexUpdate.source);

  return {
    ok: true,
    result: {
      preview: built.preview,
      run,
    },
  };
}

function buildAuthoringValidator(
  rootDir: string,
  request: AuthoringRequest,
): { ok: true; factory: AuthoringFactory; validator: Validator; preview: AuthoringPreview } | { ok: false; diagnostics: unknown[] } {
  const factory = factoryById(request.factoryId);
  if (!factory) return { ok: false, diagnostics: [authoringDiagnostic(`Unknown validator factory: ${request.factoryId}.`)] };
  const diagnostics = validateAuthoringOptions(factory, request.options);
  diagnostics.push(...validateFixtureSet(request.fixtures));
  if (diagnostics.length > 0) return { ok: false, diagnostics: diagnostics.map(authoringDiagnostic) };

  let convention;
  try {
    convention = factory.create(request.options);
  } catch (error) {
    return { ok: false, diagnostics: [authoringDiagnostic(error instanceof Error ? error.message : String(error))] };
  }
  const definition = conventionToValidator(convention);
  if (!definition) return { ok: false, diagnostics: [authoringDiagnostic("Factory did not create an enforcing convention.")] };
  const resolved = resolveValidators(definition);
  if (resolved.diagnostics.length > 0) return { ok: false, diagnostics: resolved.diagnostics.map(authoringDiagnostic) };
  const validator = resolved.validators[0];
  if (!validator) return { ok: false, diagnostics: [authoringDiagnostic("Factory did not create a validator.")] };

  const paths = createPaths(rootDir);
  const validatorPath = path.join(path.dirname(paths.conventionsPath), `${validator.id}.ts`);
  const importName = importNameForValidator(validator.id);
  const preview = {
    validatorId: validator.id,
    validatorPath: relative(rootDir, validatorPath),
    indexPath: relative(rootDir, paths.conventionsPath),
    importName,
    source: renderValidatorSource(factory, request.options),
  };
  return { ok: true, factory, validator, preview };
}

async function runFixtures(rootDir: string, validator: Validator, fixtures: AuthoringFixtureSet): Promise<AuthoringFixtureRun> {
  const project = await loadProjectContext(rootDir);
  const paths = project.paths;
  const runtime = createRuntime(paths, project.conventions);
  const findingValidationContext = {
    paths,
    conventionIds: new Set([...project.conventions.map((convention) => convention.id), ...validator.conventionIds]),
  };
  const cases: AuthoringFixtureRunCase[] = [];

  for (const fixtureCase of [AuthoringFixtureCase.Valid, AuthoringFixtureCase.Invalid]) {
    const tempRoot = mkdtempSync(path.join(tmpdir(), `opencanon-authoring-${validator.id}-${fixtureCase}-`));
    try {
      for (const file of fixtures[fixtureCase]) {
        const target = path.join(tempRoot, file.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, file.content, TextEncoding.Utf8);
      }
      const ctx = createValidationContextFromFixture({ rootDir: tempRoot, validator });
      const findings = await Promise.resolve(validator.validate({ ctx, runtime }));
      const details = validateFindings(validator, findings, findingValidationContext);
      cases.push({
        case: fixtureCase,
        passed: (fixtureCase === AuthoringFixtureCase.Valid ? findings.length === 0 : findings.length > 0) && details.length === 0,
        findings,
        details,
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  return { passed: cases.every((item) => item.passed), cases };
}

function parseAuthoringRequest(body: Record<string, unknown>): { ok: true; request: AuthoringRequest } | { ok: false; diagnostics: unknown[] } {
  const factoryId = body.factoryId;
  const options = body.options;
  const fixtures = body.fixtures;
  const diagnostics: string[] = [];

  if (!isAuthoringFactoryId(factoryId)) diagnostics.push("factoryId must be a known authoring factory id.");
  if (!isRecord(options)) diagnostics.push("options must be a JSON object.");
  if (!isRecord(fixtures)) diagnostics.push("fixtures must be a JSON object.");

  const valid = isRecord(fixtures) ? fixtureFiles(fixtures[AuthoringFixtureCase.Valid]) : [];
  const invalid = isRecord(fixtures) ? fixtureFiles(fixtures[AuthoringFixtureCase.Invalid]) : [];
  if (valid.length === 0) diagnostics.push("valid fixtures need at least one file.");
  if (invalid.length === 0) diagnostics.push("invalid fixtures need at least one file.");
  if (diagnostics.length > 0 || !isAuthoringFactoryId(factoryId) || !isRecord(options)) {
    return { ok: false, diagnostics: diagnostics.map(authoringDiagnostic) };
  }

  return {
    ok: true,
    request: {
      factoryId,
      options,
      fixtures: { valid, invalid },
    },
  };
}

function validateAuthoringOptions(factory: AuthoringFactory, options: Record<string, unknown>): string[] {
  const diagnostics: string[] = [];
  const knownKeys = new Set(factory.fields.map((field) => field.key));
  for (const key of Object.keys(options)) {
    if (!knownKeys.has(key)) diagnostics.push(`Unknown option for ${factory.id}: ${key}.`);
  }
  for (const field of factory.fields) {
    const value = options[field.key];
    if (field.required && isEmptyOption(value)) diagnostics.push(`${field.label} is required.`);
  }
  const id = optionalStringOption(options, AuthoringOption.Id);
  if (id && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) diagnostics.push("Convention id must be kebab-case.");
  const severity = options[AuthoringOption.Severity];
  if (severity !== AuthoringSeverity.Error && severity !== AuthoringSeverity.Warning) diagnostics.push("Severity must be error or warning.");
  for (const field of factory.fields) {
    if (field.kind === AuthoringFieldKind.RegexLines && regexListDiagnostics(options[field.key]).length > 0) {
      diagnostics.push(...regexListDiagnostics(options[field.key]).map((item) => `${field.label}: ${item}`));
    }
  }
  return diagnostics;
}

function validateFixtureSet(fixtures: AuthoringFixtureSet): string[] {
  const diagnostics: string[] = [];
  for (const fixtureCase of [AuthoringFixtureCase.Valid, AuthoringFixtureCase.Invalid]) {
    for (const file of fixtures[fixtureCase]) {
      if (!isSafeRelativePath(file.path)) diagnostics.push(`${fixtureCase} fixture path is not safe: ${file.path}.`);
      if (!isSupportedSourceFile(file.path)) diagnostics.push(`${fixtureCase} fixture path must be a source file: ${file.path}.`);
    }
  }
  return diagnostics;
}

function writeFixtureSet(fixturesDir: string, validatorId: string, fixtures: AuthoringFixtureSet): void {
  for (const fixtureCase of [AuthoringFixtureCase.Valid, AuthoringFixtureCase.Invalid]) {
    const target = path.join(fixturesDir, validatorId, `${fixtureCase}.ts`);
    writeAtomicTextFileSync(target, renderFixtureSource(fixtures[fixtureCase]));
  }
}

function renderFixtureSource(files: AuthoringFixtureFile[]): string {
  const lines = [
    'import { defineFixture } from "@opencanon/core/testing";',
    "",
    "export default defineFixture({",
    "  files: ({ file }) => [",
  ];
  for (const item of files) {
    lines.push(`    file(${JSON.stringify(item.path)}, ${JSON.stringify(item.content)}),`);
  }
  lines.push("  ],");
  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

function updateValidatorIndex(
  indexPath: string,
  importName: string,
  importSource: string,
): { ok: true; source: string } | { ok: false; diagnostics: unknown[] } {
  if (!existsSync(indexPath)) return { ok: false, diagnostics: [authoringDiagnostic(`Conventions index does not exist: ${indexPath}.`)] };
  const source = readFileSync(indexPath, TextEncoding.Utf8);
  if (source.includes(` ${importName} `) || source.includes(` ${importName} from`)) {
    return { ok: false, diagnostics: [authoringDiagnostic(`Import name already exists in conventions index: ${importName}.`)] };
  }
  const doubleQuotedImport = `"${importSource}"`;
  const singleQuotedImport = `'${importSource}'`;
  if (source.includes(doubleQuotedImport) || source.includes(singleQuotedImport)) {
    return { ok: false, diagnostics: [authoringDiagnostic(`Convention import already exists in index: ${importSource}.`)] };
  }

  const lines = source.split(/\r?\n/);
  const lastImportIndex = lines.findLastIndex((line) => line.startsWith("import "));
  if (lastImportIndex === -1) {
    const markerLineIndex = lines.findIndex((line) => line.startsWith("export default ["));
    if (markerLineIndex === -1) return { ok: false, diagnostics: [authoringDiagnostic("Conventions index must export a default conventions array.")] };
    lines.splice(markerLineIndex, 0, `import ${importName} from ${doubleQuotedImport};`, "");
  } else {
    lines.splice(lastImportIndex + 1, 0, `import ${importName} from ${doubleQuotedImport};`);
  }
  const withImport = lines.join("\n");
  const marker = "export default [";
  const markerIndex = withImport.indexOf(marker);
  if (markerIndex === -1) return { ok: false, diagnostics: [authoringDiagnostic("Conventions index must export a default conventions array.")] };
  const insertIndex = markerIndex + marker.length;
  const nextSource = `${withImport.slice(0, insertIndex)}\n  ${importName},${withImport.slice(insertIndex)}`;
  return { ok: true, source: nextSource.endsWith("\n") ? nextSource : `${nextSource}\n` };
}

function renderValidatorSource(factory: AuthoringFactory, options: Record<string, unknown>): string {
  const renderedOptions = renderOptions(factory, options);
  return [
    `import { ${factory.id} } from "@opencanon/validators";`,
    "",
    `const convention = ${factory.id}(${renderedOptions});`,
    "",
    "export default convention;",
    "",
  ].join("\n");
}

function renderOptions(factory: AuthoringFactory, options: Record<string, unknown>): string {
  const lines = factory.sourceFields.flatMap((field) => {
    const value = sourceValueForOption(factory, field, options);
    if (value === undefined) return [];
    return [`  ${sourceFieldName(field)}: ${renderTypeScriptValue(value)},`];
  });
  return `{\n${lines.join("\n")}\n}`;
}

function sourceValueForOption(factory: AuthoringFactory, field: AuthoringOptionValue, options: Record<string, unknown>): unknown {
  const descriptor = factory.fields.find((item) => item.key === field);
  if (field === AuthoringOption.Topics || field === AuthoringOption.Related || field === AuthoringOption.Docs) {
    const value = stringListOption(options, field);
    return value.length > 0 ? value : undefined;
  }
  if (field === AuthoringOption.FixDescription) {
    const description = optionalStringOption(options, field);
    return description ? { safety: AuthoringFixSafety.Manual, description } : undefined;
  }
  if (field === AuthoringOption.Calls || field === AuthoringOption.Patterns || field === AuthoringOption.Allow || field === AuthoringOption.ReasonPatterns) {
    const value = regexListOption(options, field);
    return value.length > 0 || descriptor?.required ? value : undefined;
  }
  if (field === AuthoringOption.MaxDepth) return numberOption(options, field, 1);
  if (field === AuthoringOption.HeaderLines) return numberOption(options, field, 12);
  if (field === AuthoringOption.RequireReason) return booleanOption(options, field, false);
  if (field === AuthoringOption.SafeFix) return booleanOption(options, field, true);
  if (
    field === AuthoringOption.In ||
    field === AuthoringOption.From ||
    field === AuthoringOption.To ||
    field === AuthoringOption.Suffix ||
    field === AuthoringOption.AllowNames ||
    field === AuthoringOption.Names
  ) {
    const value = stringListOption(options, field);
    return value.length > 0 ? value : undefined;
  }
  return optionalStringOption(options, field);
}

function renderTypeScriptValue(value: unknown): string {
  if (value instanceof RegExp) return value.toString();
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) => `    ${renderTypeScriptValue(item)},`).join("\n")}\n  ]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return `{\n${entries.map(([key, entry]) => `    ${key}: ${renderTypeScriptValue(entry)},`).join("\n")}\n  }`;
  }
  return JSON.stringify(value);
}

function baseFactoryOptions(options: Record<string, unknown>) {
  const fixDescription = optionalStringOption(options, AuthoringOption.FixDescription);
  return {
    id: stringOption(options, AuthoringOption.Id),
    topics: stringListOption(options, AuthoringOption.Topics),
    severity: severityOption(options),
    related: stringListOption(options, AuthoringOption.Related),
    docs: stringListOption(options, AuthoringOption.Docs),
    message: stringOption(options, AuthoringOption.Message),
    fix: fixDescription ? { safety: AuthoringFixSafety.Manual, description: fixDescription } : undefined,
  };
}

function sourceFieldName(field: AuthoringOptionValue): string {
  if (field === AuthoringOption.HeaderLines) return "maxHeaderLines";
  return field === AuthoringOption.FixDescription ? "fix" : field;
}

function discoverValidatorSourceFiles(rootDir: string, indexPath: string): Map<string, string> {
  const result = new Map<string, string>();
  const dir = path.dirname(indexPath);
  if (!existsSync(dir)) return result;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file === path.basename(indexPath)) continue;
    const absolutePath = path.join(dir, file);
    const text = readFileSync(absolutePath, TextEncoding.Utf8);
    for (const match of text.matchAll(/\bid:\s*["']([a-z][a-z0-9]*(?:-[a-z0-9]+)*)["']/g)) {
      result.set(match[1], relative(rootDir, absolutePath));
    }
  }
  return result;
}

function fixtureCases(fixturesDir: string, validatorId: string): AuthoringFixtureCase[] {
  return [AuthoringFixtureCase.Valid, AuthoringFixtureCase.Invalid].filter((fixtureCase) => existsSync(path.join(fixturesDir, validatorId, `${fixtureCase}.ts`)));
}

function factoryById(id: AuthoringFactoryId): AuthoringFactory | undefined {
  return authoringFactories.find((factory) => factory.id === id);
}

function isAuthoringFactoryId(value: unknown): value is AuthoringFactoryId {
  return typeof value === "string" && authoringFactories.some((factory) => factory.id === value);
}

function fixtureFiles(value: unknown): AuthoringFixtureFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((file): file is Record<string, unknown> => isRecord(file))
    .flatMap((file) => {
      if (typeof file.path !== "string" || typeof file.content !== "string") return [];
      return [{ path: normalizeFixturePath(file.path), content: file.content }];
    });
}

function stringOption(options: Record<string, unknown>, key: AuthoringOptionValue): string {
  const value = optionalStringOption(options, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function optionalStringOption(options: Record<string, unknown>, key: AuthoringOptionValue): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringListOption(options: Record<string, unknown>, key: AuthoringOptionValue): string[] {
  const value = options[key];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function regexListOption(options: Record<string, unknown>, key: AuthoringOptionValue): RegExp[] {
  return stringListOption(options, key).map(parseRegex);
}

function regexListDiagnostics(value: unknown): string[] {
  return stringListValue(value).flatMap((item) => {
    try {
      parseRegex(item);
      return [];
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  });
}

function parseRegex(value: string): RegExp {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("empty regular expression.");
  if (trimmed.startsWith("/")) {
    const lastSlash = trimmed.lastIndexOf("/");
    if (lastSlash > 0) return new RegExp(trimmed.slice(1, lastSlash), trimmed.slice(lastSlash + 1));
  }
  return new RegExp(trimmed);
}

function numberOption(options: Record<string, unknown>, key: AuthoringOptionValue, fallback: number): number {
  const value = options[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return fallback;
}

function booleanOption(options: Record<string, unknown>, key: AuthoringOptionValue, fallback: boolean): boolean {
  const value = options[key];
  return typeof value === "boolean" ? value : fallback;
}

function severityOption(options: Record<string, unknown>): "error" | "warning" {
  return options[AuthoringOption.Severity] === AuthoringSeverity.Error ? AuthoringSeverity.Error : AuthoringSeverity.Warning;
}

function isEmptyOption(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function stringListValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return value.split(/\r?\n/);
  return [];
}

function importNameForValidator(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, value: string) => value.toUpperCase());
}

function normalizeFixturePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function isSafeRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  return normalized !== "." && !normalized.startsWith("../") && !normalized.split("/").includes("..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function authoringDiagnostic(message: string) {
  return createOpenCanonDiagnostic({ code: "authoring-invalid", message });
}
