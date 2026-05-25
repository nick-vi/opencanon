import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createOpenCanonDiagnostic,
  createPaths,
  createRuntime,
  createValidationContextFromFixture,
  loadContextFiles,
  loadProjectContext,
  relative,
  resolveValidators,
  validateFindings,
  writeAtomicTextFileSync,
  type Validator,
  type ValidatorDefinition,
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
  SourceExtensionPattern,
  StudioFactoryId,
  StudioFixtureCase,
  StudioFixtureContent,
  StudioFixturePath,
  StudioFieldKind,
  StudioFixSafety,
  StudioLabel,
  StudioOption,
  StudioPattern,
  StudioSeverity,
  StudioTopic,
  TextEncoding,
} from "./studio-types.ts";
import type {
  StudioApplyResult,
  StudioFactory,
  StudioFactoryDescriptor,
  StudioFieldDescriptor,
  StudioFixtureFile,
  StudioFixtureRun,
  StudioFixtureRunCase,
  StudioFixtureSet,
  StudioOption as StudioOptionValue,
  StudioPreview,
  StudioRequest,
  StudioValidatorSummary,
} from "./studio-types.ts";
const commonFields: StudioFieldDescriptor[] = [
  { key: StudioOption.Id, label: "Validator id", kind: StudioFieldKind.Text, required: true, placeholder: "no-unsafe-db-imports" },
  { key: StudioOption.Topics, label: "Topics", kind: StudioFieldKind.Lines, required: true, placeholder: "imports" },
  { key: StudioOption.Severity, label: "Severity", kind: StudioFieldKind.Select, required: true, options: [StudioSeverity.Warning, StudioSeverity.Error] },
  { key: StudioOption.DecisionIds, label: "Decision ids", kind: StudioFieldKind.Lines },
  { key: StudioOption.Docs, label: "Docs", kind: StudioFieldKind.Lines },
  { key: StudioOption.Message, label: "Finding message", kind: StudioFieldKind.Textarea, required: true },
  { key: StudioOption.FixDescription, label: "Fix description", kind: StudioFieldKind.Textarea },
];

const studioFactories: StudioFactory[] = [
  {
    id: StudioFactoryId.NoForbiddenCalls,
    label: "Forbidden calls",
    summary: "Find calls matching one or more regular expressions.",
    fields: [
      ...commonFields,
      { key: StudioOption.In, label: StudioLabel.AppliesTo, kind: StudioFieldKind.Lines, required: true },
      { key: StudioOption.Calls, label: "Call patterns", kind: StudioFieldKind.RegexLines, required: true },
    ],
    defaults: {
      [StudioOption.Id]: "no-forbidden-calls",
      [StudioOption.Topics]: [StudioTopic.Hygiene],
      [StudioOption.Severity]: StudioSeverity.Warning,
      [StudioOption.In]: [StudioPattern.TypeScriptSources, StudioPattern.PackageTypeScriptSources],
      [StudioOption.Calls]: ["eval\\("],
      [StudioOption.Message]: "Forbidden API call.",
      [StudioOption.FixDescription]: "Replace this call with an approved local abstraction.",
    },
    fixtures: {
      valid: [{ path: StudioFixturePath.ExampleTs, content: "export function run(input: string) {\n  return input.trim();\n}\n" }],
      invalid: [{ path: StudioFixturePath.ExampleTs, content: "export function run(input: string) {\n  return eval(input);\n}\n" }],
    },
    sourceFields: [
      StudioOption.Id,
      StudioOption.Topics,
      StudioOption.In,
      StudioOption.Severity,
      StudioOption.DecisionIds,
      StudioOption.Calls,
      StudioOption.Message,
      StudioOption.FixDescription,
      StudioOption.Docs,
    ],
    create: (options) =>
      noForbiddenCalls({
        ...baseFactoryOptions(options),
        in: stringListOption(options, StudioOption.In),
        calls: regexListOption(options, StudioOption.Calls),
      }),
  },
  {
    id: StudioFactoryId.NoCommentMatches,
    label: "Forbidden comments",
    summary: "Find comments matching one or more regular expressions.",
    fields: [
      ...commonFields,
      { key: StudioOption.In, label: StudioLabel.AppliesTo, kind: StudioFieldKind.Lines, required: true },
      { key: StudioOption.Patterns, label: "Comment patterns", kind: StudioFieldKind.RegexLines, required: true },
    ],
    defaults: {
      [StudioOption.Id]: "no-stale-comments",
      [StudioOption.Topics]: [StudioTopic.Comments],
      [StudioOption.Severity]: StudioSeverity.Warning,
      [StudioOption.In]: [StudioPattern.SourceCommentFiles, StudioPattern.TestCommentFiles],
      [StudioOption.Patterns]: ["legacy|deprecated|shim"],
      [StudioOption.Message]: "Comment describes stale implementation intent.",
      [StudioOption.FixDescription]: "Update the code to the current pattern and remove the stale comment.",
    },
    fixtures: {
      valid: [{ path: StudioFixturePath.ExampleTs, content: StudioFixtureContent.Current }],
      invalid: [{ path: StudioFixturePath.ExampleTs, content: `// legacy compatibility path\n${StudioFixtureContent.Current}` }],
    },
    sourceFields: [
      StudioOption.Id,
      StudioOption.Topics,
      StudioOption.In,
      StudioOption.Severity,
      StudioOption.DecisionIds,
      StudioOption.Patterns,
      StudioOption.Message,
      StudioOption.FixDescription,
      StudioOption.Docs,
    ],
    create: (options) =>
      noCommentMatches({
        ...baseFactoryOptions(options),
        in: stringListOption(options, StudioOption.In),
        patterns: regexListOption(options, StudioOption.Patterns),
      }),
  },
  {
    id: StudioFactoryId.NoHeaderComments,
    label: "Header comments",
    summary: "Deny file-level header or provenance comments before code.",
    fields: [
      ...commonFields,
      { key: StudioOption.In, label: StudioLabel.AppliesTo, kind: StudioFieldKind.Lines, required: true },
      { key: StudioOption.HeaderLines, label: "Header scan lines", kind: StudioFieldKind.Number, required: true },
      { key: StudioOption.Patterns, label: "Header patterns", kind: StudioFieldKind.RegexLines },
      { key: StudioOption.Allow, label: "Allowed header patterns", kind: StudioFieldKind.RegexLines },
    ],
    defaults: {
      [StudioOption.Id]: "no-header-comments",
      [StudioOption.Topics]: [StudioTopic.Comments],
      [StudioOption.Severity]: StudioSeverity.Warning,
      [StudioOption.In]: [StudioPattern.SourceCommentFiles, StudioPattern.TestCommentFiles],
      [StudioOption.HeaderLines]: 12,
      [StudioOption.Patterns]: [],
      [StudioOption.Allow]: ["^SPDX-License-Identifier:", "^@license\\b", "^!\\/usr\\/bin\\/env\\b"],
      [StudioOption.Message]: "File starts with an unapproved header comment.",
      [StudioOption.FixDescription]: "Remove the header comment unless it is required license, shebang, or reference metadata.",
    },
    fixtures: {
      valid: [{ path: StudioFixturePath.ExampleTs, content: StudioFixtureContent.Current }],
      invalid: [{ path: StudioFixturePath.ExampleTs, content: `// This file contains shared utility functions.\n${StudioFixtureContent.Current}` }],
    },
    sourceFields: [
      StudioOption.Id,
      StudioOption.Topics,
      StudioOption.In,
      StudioOption.Severity,
      StudioOption.DecisionIds,
      StudioOption.HeaderLines,
      StudioOption.Patterns,
      StudioOption.Allow,
      StudioOption.Message,
      StudioOption.FixDescription,
      StudioOption.Docs,
    ],
    create: (options) =>
      noHeaderComments({
        ...baseFactoryOptions(options),
        in: stringListOption(options, StudioOption.In),
        maxHeaderLines: numberOption(options, StudioOption.HeaderLines, 12),
        patterns: regexListOption(options, StudioOption.Patterns),
        allow: regexListOption(options, StudioOption.Allow),
      }),
  },
  {
    id: StudioFactoryId.NoBypassComments,
    label: "Bypass comments",
    summary: "Deny linter, typechecker, no-verify, and OpenCanon suppression comments.",
    fields: [
      ...commonFields,
      { key: StudioOption.In, label: StudioLabel.AppliesTo, kind: StudioFieldKind.Lines, required: true },
      { key: StudioOption.Patterns, label: "Bypass patterns", kind: StudioFieldKind.RegexLines },
      { key: StudioOption.Allow, label: "Allowed bypass patterns", kind: StudioFieldKind.RegexLines },
      { key: StudioOption.RequireReason, label: "Allow only with approved reason", kind: StudioFieldKind.Boolean },
      { key: StudioOption.ReasonPatterns, label: "Required reason patterns", kind: StudioFieldKind.RegexLines },
    ],
    defaults: {
      [StudioOption.Id]: "no-bypass-comments",
      [StudioOption.Topics]: [StudioTopic.Comments, StudioTopic.QualityGates],
      [StudioOption.Severity]: StudioSeverity.Error,
      [StudioOption.In]: [StudioPattern.SourceCommentFiles, StudioPattern.TestCommentFiles],
      [StudioOption.Patterns]: ["eslint-disable(?:-next-line|-line)?", "@ts-(?:ignore|expect-error|nocheck)", "noqa|type:\\s*ignore|pylint:\\s*disable", "opencanon-(?:disable|ignore|skip)", "no-verify"],
      [StudioOption.Allow]: [],
      [StudioOption.RequireReason]: false,
      [StudioOption.ReasonPatterns]: ["OPENCANON-EXCEPTION-[0-9]+", "[A-Z]+-[0-9]+"],
      [StudioOption.Message]: "Bypass comments are not allowed without an approved project policy.",
      [StudioOption.FixDescription]: "Remove the bypass comment and fix the underlying issue, or document a project-level exception.",
    },
    fixtures: {
      valid: [{ path: StudioFixturePath.ExampleTs, content: StudioFixtureContent.Current }],
      invalid: [{ path: StudioFixturePath.ExampleTs, content: "// eslint-disable-next-line no-console\nconsole.log(\"debug\");\n" }],
    },
    sourceFields: [
      StudioOption.Id,
      StudioOption.Topics,
      StudioOption.In,
      StudioOption.Severity,
      StudioOption.DecisionIds,
      StudioOption.Patterns,
      StudioOption.Allow,
      StudioOption.RequireReason,
      StudioOption.ReasonPatterns,
      StudioOption.Message,
      StudioOption.FixDescription,
      StudioOption.Docs,
    ],
    create: (options) =>
      noBypassComments({
        ...baseFactoryOptions(options),
        in: stringListOption(options, StudioOption.In),
        patterns: regexListOption(options, StudioOption.Patterns),
        allow: regexListOption(options, StudioOption.Allow),
        requireReason: booleanOption(options, StudioOption.RequireReason, false),
        reasonPatterns: regexListOption(options, StudioOption.ReasonPatterns),
      }),
  },
  {
    id: StudioFactoryId.FileNames,
    label: "File names",
    summary: "Require matching file names or suffixes under configured globs.",
    fields: [
      ...commonFields,
      { key: StudioOption.In, label: StudioLabel.AppliesTo, kind: StudioFieldKind.Lines, required: true },
      { key: StudioOption.Suffix, label: "Required suffixes", kind: StudioFieldKind.Lines, required: true },
      { key: StudioOption.AllowNames, label: "Allowed exact names", kind: StudioFieldKind.Lines },
    ],
    defaults: {
      [StudioOption.Id]: "service-file-names",
      [StudioOption.Topics]: [StudioTopic.FolderStructure],
      [StudioOption.Severity]: StudioSeverity.Warning,
      [StudioOption.In]: ["src/services/**/*.{ts,tsx}"],
      [StudioOption.Suffix]: [".service.ts", ".service.tsx"],
      [StudioOption.AllowNames]: ["index.ts", "index.tsx"],
      [StudioOption.Message]: "File name does not match the required naming pattern.",
      [StudioOption.FixDescription]: "Rename the file and update imports.",
    },
    fixtures: {
      valid: [{ path: "src/services/company.service.ts", content: StudioFixtureContent.CompanyService }],
      invalid: [{ path: StudioFixturePath.ServiceCompany, content: StudioFixtureContent.CompanyService }],
    },
    sourceFields: [
      StudioOption.Id,
      StudioOption.Topics,
      StudioOption.In,
      StudioOption.Severity,
      StudioOption.DecisionIds,
      StudioOption.Suffix,
      StudioOption.AllowNames,
      StudioOption.Message,
      StudioOption.FixDescription,
      StudioOption.Docs,
    ],
    create: (options) =>
      fileNames({
        ...baseFactoryOptions(options),
        in: stringListOption(options, StudioOption.In),
        suffix: stringListOption(options, StudioOption.Suffix),
        allowNames: stringListOption(options, StudioOption.AllowNames),
      }),
  },
  {
    id: StudioFactoryId.NoImports,
    label: "Import boundary",
    summary: "Deny imports from one set of files to another set of files or packages.",
    fields: [
      ...commonFields,
      { key: StudioOption.From, label: "From", kind: StudioFieldKind.Lines, required: true },
      { key: StudioOption.To, label: "Denied imports", kind: StudioFieldKind.Lines, required: true },
    ],
    defaults: {
      [StudioOption.Id]: "no-layer-imports",
      [StudioOption.Topics]: [StudioTopic.Imports],
      [StudioOption.Severity]: StudioSeverity.Error,
      [StudioOption.From]: ["src/services/**/*.{ts,tsx}"],
      [StudioOption.To]: [StudioFixturePath.DbClient, "**/db/client"],
      [StudioOption.Message]: "Import crosses a denied ownership boundary.",
      [StudioOption.FixDescription]: "Move the dependency behind an approved facade.",
    },
    fixtures: {
      valid: [
        { path: StudioFixturePath.ServiceCompany, content: StudioFixtureContent.CompanyService },
        { path: StudioFixturePath.DbClient, content: StudioFixtureContent.DbClient },
      ],
      invalid: [
        { path: StudioFixturePath.ServiceCompany, content: "import { db } from \"../db/client\";\nexport const companyService = db;\n" },
        { path: StudioFixturePath.DbClient, content: StudioFixtureContent.DbClient },
      ],
    },
    sourceFields: [
      StudioOption.Id,
      StudioOption.Topics,
      StudioOption.From,
      StudioOption.To,
      StudioOption.Severity,
      StudioOption.DecisionIds,
      StudioOption.Message,
      StudioOption.FixDescription,
      StudioOption.Docs,
    ],
    create: (options) =>
      noImports({
        ...baseFactoryOptions(options),
        from: stringListOption(options, StudioOption.From),
        to: stringListOption(options, StudioOption.To),
      }),
  },
  {
    id: StudioFactoryId.NoNativeEnums,
    label: "Native enums",
    summary: "Require const-object enum patterns instead of TypeScript enums.",
    fields: [
      { key: StudioOption.Id, label: "Validator id", kind: StudioFieldKind.Text, required: true },
      { key: StudioOption.Topics, label: "Topics", kind: StudioFieldKind.Lines, required: true },
      { key: StudioOption.Severity, label: "Severity", kind: StudioFieldKind.Select, required: true, options: [StudioSeverity.Warning, StudioSeverity.Error] },
      { key: StudioOption.DecisionIds, label: "Decision ids", kind: StudioFieldKind.Lines },
      { key: StudioOption.Docs, label: "Docs", kind: StudioFieldKind.Lines },
      { key: StudioOption.In, label: StudioLabel.AppliesTo, kind: StudioFieldKind.Lines, required: true },
      { key: StudioOption.Message, label: "Finding message", kind: StudioFieldKind.Textarea },
      { key: StudioOption.SafeFix, label: "Enable safe string-enum fix", kind: StudioFieldKind.Boolean },
    ],
    defaults: {
      [StudioOption.Id]: "no-native-enums",
      [StudioOption.Topics]: [StudioTopic.TypePatterns],
      [StudioOption.Severity]: StudioSeverity.Error,
      [StudioOption.In]: [StudioPattern.TypeScriptSources],
      [StudioOption.SafeFix]: true,
      [StudioOption.Message]: "Native TypeScript enums are not allowed.",
    },
    fixtures: {
      valid: [{ path: "src/status.ts", content: "export const Status = { ACTIVE: \"active\" } as const;\nexport type Status = (typeof Status)[keyof typeof Status];\n" }],
      invalid: [{ path: "src/status.ts", content: "export enum Status {\n  ACTIVE = \"active\",\n}\n" }],
    },
    sourceFields: [
      StudioOption.Id,
      StudioOption.Topics,
      StudioOption.In,
      StudioOption.Severity,
      StudioOption.DecisionIds,
      StudioOption.Message,
      StudioOption.SafeFix,
      StudioOption.Docs,
    ],
    create: (options) =>
      noNativeEnums({
        id: stringOption(options, StudioOption.Id),
        topics: stringListOption(options, StudioOption.Topics),
        in: stringListOption(options, StudioOption.In),
        severity: severityOption(options),
        decisionIds: stringListOption(options, StudioOption.DecisionIds),
        docs: stringListOption(options, StudioOption.Docs),
        message: optionalStringOption(options, StudioOption.Message),
        safeFix: booleanOption(options, StudioOption.SafeFix, true),
      }),
  },
  {
    id: StudioFactoryId.NoDeepRelativeImports,
    label: "Relative import depth",
    summary: "Limit how far relative imports may climb.",
    fields: [
      ...commonFields,
      { key: StudioOption.In, label: StudioLabel.AppliesTo, kind: StudioFieldKind.Lines, required: true },
      { key: StudioOption.MaxDepth, label: "Max relative depth", kind: StudioFieldKind.Number, required: true },
    ],
    defaults: {
      [StudioOption.Id]: "no-deep-relative-imports",
      [StudioOption.Topics]: [StudioTopic.Imports],
      [StudioOption.Severity]: StudioSeverity.Warning,
      [StudioOption.In]: [StudioPattern.TypeScriptSources, StudioPattern.TestTypeScriptSources],
      [StudioOption.MaxDepth]: 1,
      [StudioOption.Message]: "Relative import climbs too far across ownership boundaries.",
      [StudioOption.FixDescription]: "Use an approved import surface or move the helper closer.",
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
      StudioOption.Id,
      StudioOption.Topics,
      StudioOption.In,
      StudioOption.Severity,
      StudioOption.DecisionIds,
      StudioOption.MaxDepth,
      StudioOption.Message,
      StudioOption.FixDescription,
      StudioOption.Docs,
    ],
    create: (options) =>
      noDeepRelativeImports({
        ...baseFactoryOptions(options),
        in: stringListOption(options, StudioOption.In),
        maxDepth: numberOption(options, StudioOption.MaxDepth, 1),
      }),
  },
  {
    id: StudioFactoryId.NoFolderNames,
    label: "Folder names",
    summary: "Deny ambiguous folder names under configured roots.",
    fields: [
      ...commonFields,
      { key: StudioOption.In, label: "Roots", kind: StudioFieldKind.Lines, required: true },
      { key: StudioOption.Names, label: "Denied folder names", kind: StudioFieldKind.Lines, required: true },
    ],
    defaults: {
      [StudioOption.Id]: "no-ambiguous-folders",
      [StudioOption.Topics]: [StudioTopic.FolderStructure],
      [StudioOption.Severity]: StudioSeverity.Warning,
      [StudioOption.In]: ["src", "tests", "packages/*/src"],
      [StudioOption.Names]: ["misc", "helpers", "common"],
      [StudioOption.Message]: "Folder name is too ambiguous for source ownership.",
      [StudioOption.FixDescription]: "Move the flow into a responsibility-named folder.",
    },
    fixtures: {
      valid: [{ path: StudioFixturePath.ServiceCompany, content: StudioFixtureContent.CompanyService }],
      invalid: [{ path: "src/misc/company.ts", content: StudioFixtureContent.CompanyService }],
    },
    sourceFields: [
      StudioOption.Id,
      StudioOption.Topics,
      StudioOption.In,
      StudioOption.Severity,
      StudioOption.DecisionIds,
      StudioOption.Names,
      StudioOption.Message,
      StudioOption.FixDescription,
      StudioOption.Docs,
    ],
    create: (options) =>
      noFolderNames({
        ...baseFactoryOptions(options),
        in: stringListOption(options, StudioOption.In),
        names: stringListOption(options, StudioOption.Names),
      }),
  },
  {
    id: StudioFactoryId.RequiredFileSibling,
    label: "Required sibling file",
    summary: "Require files matching a glob to have a sibling file.",
    fields: [
      ...commonFields,
      { key: StudioOption.In, label: StudioLabel.AppliesTo, kind: StudioFieldKind.Lines, required: true },
      { key: StudioOption.Sibling, label: "Sibling template", kind: StudioFieldKind.Text, required: true, placeholder: "{stem}.test.ts" },
    ],
    defaults: {
      [StudioOption.Id]: "required-sibling-test",
      [StudioOption.Topics]: [StudioTopic.Testing],
      [StudioOption.Severity]: StudioSeverity.Warning,
      [StudioOption.In]: ["src/**/*.ts"],
      [StudioOption.Sibling]: "{stem}.test.ts",
      [StudioOption.Message]: "File is missing a required sibling.",
      [StudioOption.FixDescription]: "Add the required sibling file or document why this path is exempt.",
    },
    fixtures: {
      valid: [
        { path: "src/company.ts", content: "export const company = {};\n" },
        { path: "src/company.test.ts", content: "import { company } from \"./company\";\nvoid company;\n" },
      ],
      invalid: [{ path: "src/company.ts", content: "export const company = {};\n" }],
    },
    sourceFields: [
      StudioOption.Id,
      StudioOption.Topics,
      StudioOption.In,
      StudioOption.Severity,
      StudioOption.DecisionIds,
      StudioOption.Sibling,
      StudioOption.Message,
      StudioOption.FixDescription,
      StudioOption.Docs,
    ],
    create: (options) =>
      requiredFileSibling({
        ...baseFactoryOptions(options),
        in: stringListOption(options, StudioOption.In),
        sibling: stringOption(options, StudioOption.Sibling),
      }),
  },
];

export function listStudioFactories(): StudioFactoryDescriptor[] {
  return studioFactories.map(({ create: _create, sourceFields: _sourceFields, ...descriptor }) => descriptor);
}

export async function listStudioValidators(rootDir: string): Promise<StudioValidatorSummary[]> {
  const project = await loadProjectContext(rootDir);
  const sourceMap = discoverValidatorSourceFiles(rootDir, project.paths.validatorsPath);
  return project.validators.map((validator) => ({
    id: validator.id,
    severity: validator.severity,
    scope: validator.scope,
    topics: validator.topics,
    sourcePath: sourceMap.get(validator.id),
    fixtureCases: fixtureCases(project.paths.fixturesDir, validator.id),
  }));
}

export function previewStudioValidator(rootDir: string, body: Record<string, unknown>): { ok: true; preview: StudioPreview } | { ok: false; diagnostics: unknown[] } {
  const parsed = parseStudioRequest(body);
  if (!parsed.ok) return parsed;
  const built = buildStudioValidator(rootDir, parsed.request);
  if (!built.ok) return built;
  return { ok: true, preview: built.preview };
}

export async function runStudioValidatorFixtures(
  rootDir: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; run: StudioFixtureRun } | { ok: false; diagnostics: unknown[] }> {
  const parsed = parseStudioRequest(body);
  if (!parsed.ok) return parsed;
  const built = buildStudioValidator(rootDir, parsed.request);
  if (!built.ok) return built;
  return { ok: true, run: await runFixtures(rootDir, built.validator, parsed.request.fixtures) };
}

export async function applyStudioValidator(
  rootDir: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; result: StudioApplyResult } | { ok: false; diagnostics: unknown[] }> {
  const parsed = parseStudioRequest(body);
  if (!parsed.ok) return parsed;
  const built = buildStudioValidator(rootDir, parsed.request);
  if (!built.ok) return built;
  const run = await runFixtures(rootDir, built.validator, parsed.request.fixtures);
  if (!run.passed) return { ok: false, diagnostics: [studioDiagnostic("Fixtures must pass before applying the validator.")] };

  const paths = createPaths(rootDir);
  const absoluteValidatorPath = path.join(rootDir, built.preview.validatorPath);
  if (existsSync(absoluteValidatorPath)) {
    return { ok: false, diagnostics: [studioDiagnostic(`Validator file already exists: ${built.preview.validatorPath}.`)] };
  }
  const indexUpdate = updateValidatorIndex(paths.validatorsPath, built.preview.importName, `./${path.posix.basename(built.preview.validatorPath)}`);
  if (!indexUpdate.ok) return indexUpdate;

  writeAtomicTextFileSync(absoluteValidatorPath, built.preview.source);
  writeFixtureSet(paths.fixturesDir, built.preview.validatorId, parsed.request.fixtures);
  writeAtomicTextFileSync(paths.validatorsPath, indexUpdate.source);

  return {
    ok: true,
    result: {
      preview: built.preview,
      run,
    },
  };
}

function buildStudioValidator(
  rootDir: string,
  request: StudioRequest,
): { ok: true; factory: StudioFactory; validator: Validator; preview: StudioPreview } | { ok: false; diagnostics: unknown[] } {
  const factory = factoryById(request.factoryId);
  if (!factory) return { ok: false, diagnostics: [studioDiagnostic(`Unknown validator factory: ${request.factoryId}.`)] };
  const diagnostics = validateStudioOptions(factory, request.options);
  diagnostics.push(...validateFixtureSet(request.fixtures));
  if (diagnostics.length > 0) return { ok: false, diagnostics: diagnostics.map(studioDiagnostic) };

  let definition: ValidatorDefinition;
  try {
    definition = factory.create(request.options);
  } catch (error) {
    return { ok: false, diagnostics: [studioDiagnostic(error instanceof Error ? error.message : String(error))] };
  }
  const resolved = resolveValidators(definition);
  if (resolved.diagnostics.length > 0) return { ok: false, diagnostics: resolved.diagnostics.map(studioDiagnostic) };
  const validator = resolved.validators[0];
  if (!validator) return { ok: false, diagnostics: [studioDiagnostic("Factory did not create a validator.")] };

  const paths = createPaths(rootDir);
  const validatorPath = path.join(path.dirname(paths.validatorsPath), `${validator.id}.ts`);
  const importName = importNameForValidator(validator.id);
  const preview = {
    validatorId: validator.id,
    validatorPath: relative(rootDir, validatorPath),
    indexPath: relative(rootDir, paths.validatorsPath),
    importName,
    source: renderValidatorSource(rootDir, validatorPath, factory, request.options),
  };
  return { ok: true, factory, validator, preview };
}

async function runFixtures(rootDir: string, validator: Validator, fixtures: StudioFixtureSet): Promise<StudioFixtureRun> {
  const paths = createPaths(rootDir);
  const { decisions } = loadContextFiles(paths);
  const runtime = createRuntime(paths, decisions);
  const findingValidationContext = {
    paths,
    decisionIds: new Set(decisions.map((decision) => decision.id)),
  };
  const cases: StudioFixtureRunCase[] = [];

  for (const fixtureCase of [StudioFixtureCase.Valid, StudioFixtureCase.Invalid]) {
    const tempRoot = mkdtempSync(path.join(tmpdir(), `opencanon-studio-${validator.id}-${fixtureCase}-`));
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
        passed: (fixtureCase === StudioFixtureCase.Valid ? findings.length === 0 : findings.length > 0) && details.length === 0,
        findings,
        details,
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  return { passed: cases.every((item) => item.passed), cases };
}

function parseStudioRequest(body: Record<string, unknown>): { ok: true; request: StudioRequest } | { ok: false; diagnostics: unknown[] } {
  const factoryId = body.factoryId;
  const options = body.options;
  const fixtures = body.fixtures;
  const diagnostics: string[] = [];

  if (!isStudioFactoryId(factoryId)) diagnostics.push("factoryId must be a known studio factory id.");
  if (!isRecord(options)) diagnostics.push("options must be a JSON object.");
  if (!isRecord(fixtures)) diagnostics.push("fixtures must be a JSON object.");

  const valid = isRecord(fixtures) ? fixtureFiles(fixtures[StudioFixtureCase.Valid]) : [];
  const invalid = isRecord(fixtures) ? fixtureFiles(fixtures[StudioFixtureCase.Invalid]) : [];
  if (valid.length === 0) diagnostics.push("valid fixtures need at least one file.");
  if (invalid.length === 0) diagnostics.push("invalid fixtures need at least one file.");
  if (diagnostics.length > 0 || !isStudioFactoryId(factoryId) || !isRecord(options)) {
    return { ok: false, diagnostics: diagnostics.map(studioDiagnostic) };
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

function validateStudioOptions(factory: StudioFactory, options: Record<string, unknown>): string[] {
  const diagnostics: string[] = [];
  const knownKeys = new Set(factory.fields.map((field) => field.key));
  for (const key of Object.keys(options)) {
    if (!knownKeys.has(key)) diagnostics.push(`Unknown option for ${factory.id}: ${key}.`);
  }
  for (const field of factory.fields) {
    const value = options[field.key];
    if (field.required && isEmptyOption(value)) diagnostics.push(`${field.label} is required.`);
  }
  const id = optionalStringOption(options, StudioOption.Id);
  if (id && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) diagnostics.push("Validator id must be kebab-case.");
  const severity = options[StudioOption.Severity];
  if (severity !== StudioSeverity.Error && severity !== StudioSeverity.Warning) diagnostics.push("Severity must be error or warning.");
  for (const field of factory.fields) {
    if (field.kind === StudioFieldKind.RegexLines && regexListDiagnostics(options[field.key]).length > 0) {
      diagnostics.push(...regexListDiagnostics(options[field.key]).map((item) => `${field.label}: ${item}`));
    }
  }
  return diagnostics;
}

function validateFixtureSet(fixtures: StudioFixtureSet): string[] {
  const diagnostics: string[] = [];
  for (const fixtureCase of [StudioFixtureCase.Valid, StudioFixtureCase.Invalid]) {
    for (const file of fixtures[fixtureCase]) {
      if (!isSafeRelativePath(file.path)) diagnostics.push(`${fixtureCase} fixture path is not safe: ${file.path}.`);
      if (!SourceExtensionPattern.test(file.path)) diagnostics.push(`${fixtureCase} fixture path must be a source file: ${file.path}.`);
    }
  }
  return diagnostics;
}

function writeFixtureSet(fixturesDir: string, validatorId: string, fixtures: StudioFixtureSet): void {
  for (const fixtureCase of [StudioFixtureCase.Valid, StudioFixtureCase.Invalid]) {
    const target = path.join(fixturesDir, validatorId, `${fixtureCase}.ts`);
    writeAtomicTextFileSync(target, renderFixtureSource(fixtures[fixtureCase]));
  }
}

function renderFixtureSource(files: StudioFixtureFile[]): string {
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
  if (!existsSync(indexPath)) return { ok: false, diagnostics: [studioDiagnostic(`Validators index does not exist: ${indexPath}.`)] };
  const source = readFileSync(indexPath, TextEncoding.Utf8);
  if (source.includes(` ${importName} `) || source.includes(` ${importName} from`)) {
    return { ok: false, diagnostics: [studioDiagnostic(`Import name already exists in validators index: ${importName}.`)] };
  }
  const doubleQuotedImport = `"${importSource}"`;
  const singleQuotedImport = `'${importSource}'`;
  if (source.includes(doubleQuotedImport) || source.includes(singleQuotedImport)) {
    return { ok: false, diagnostics: [studioDiagnostic(`Validator import already exists in index: ${importSource}.`)] };
  }

  const lines = source.split(/\r?\n/);
  const lastImportIndex = lines.findLastIndex((line) => line.startsWith("import "));
  if (lastImportIndex === -1) return { ok: false, diagnostics: [studioDiagnostic("Validators index must have an import block.")] };
  lines.splice(lastImportIndex + 1, 0, `import ${importName} from ${doubleQuotedImport};`);
  const withImport = lines.join("\n");
  const marker = "validators: [";
  const markerIndex = withImport.indexOf(marker);
  if (markerIndex === -1) return { ok: false, diagnostics: [studioDiagnostic("Validators index must expose a root validators array.")] };
  const insertIndex = markerIndex + marker.length;
  const nextSource = `${withImport.slice(0, insertIndex)}\n    ${importName},${withImport.slice(insertIndex)}`;
  return { ok: true, source: nextSource.endsWith("\n") ? nextSource : `${nextSource}\n` };
}

function renderValidatorSource(rootDir: string, validatorPath: string, factory: StudioFactory, options: Record<string, unknown>): string {
  const importPath = relativeImport(path.dirname(validatorPath), path.join(rootDir, ".agents/skills/opencanon/index.ts"));
  const renderedOptions = renderOptions(factory, options);
  return [
    `import { ${factory.id} } from "${importPath}";`,
    "",
    `const validator = ${factory.id}(${renderedOptions});`,
    "",
    "export default validator;",
    "",
  ].join("\n");
}

function renderOptions(factory: StudioFactory, options: Record<string, unknown>): string {
  const lines = factory.sourceFields.flatMap((field) => {
    const value = sourceValueForOption(factory, field, options);
    if (value === undefined) return [];
    return [`  ${sourceFieldName(field)}: ${renderTypeScriptValue(value)},`];
  });
  return `{\n${lines.join("\n")}\n}`;
}

function sourceValueForOption(factory: StudioFactory, field: StudioOptionValue, options: Record<string, unknown>): unknown {
  const descriptor = factory.fields.find((item) => item.key === field);
  if (field === StudioOption.Topics || field === StudioOption.DecisionIds || field === StudioOption.Docs) {
    const value = stringListOption(options, field);
    return value.length > 0 ? value : undefined;
  }
  if (field === StudioOption.FixDescription) {
    const description = optionalStringOption(options, field);
    return description ? { safety: StudioFixSafety.Manual, description } : undefined;
  }
  if (field === StudioOption.Calls || field === StudioOption.Patterns || field === StudioOption.Allow || field === StudioOption.ReasonPatterns) {
    const value = regexListOption(options, field);
    return value.length > 0 || descriptor?.required ? value : undefined;
  }
  if (field === StudioOption.MaxDepth) return numberOption(options, field, 1);
  if (field === StudioOption.HeaderLines) return numberOption(options, field, 12);
  if (field === StudioOption.RequireReason) return booleanOption(options, field, false);
  if (field === StudioOption.SafeFix) return booleanOption(options, field, true);
  if (
    field === StudioOption.In ||
    field === StudioOption.From ||
    field === StudioOption.To ||
    field === StudioOption.Suffix ||
    field === StudioOption.AllowNames ||
    field === StudioOption.Names
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
  const fixDescription = optionalStringOption(options, StudioOption.FixDescription);
  return {
    id: stringOption(options, StudioOption.Id),
    topics: stringListOption(options, StudioOption.Topics),
    severity: severityOption(options),
    decisionIds: stringListOption(options, StudioOption.DecisionIds),
    docs: stringListOption(options, StudioOption.Docs),
    message: stringOption(options, StudioOption.Message),
    fix: fixDescription ? { safety: StudioFixSafety.Manual, description: fixDescription } : undefined,
  };
}

function sourceFieldName(field: StudioOptionValue): string {
  if (field === StudioOption.HeaderLines) return "maxHeaderLines";
  return field === StudioOption.FixDescription ? "fix" : field;
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

function fixtureCases(fixturesDir: string, validatorId: string): StudioFixtureCase[] {
  return [StudioFixtureCase.Valid, StudioFixtureCase.Invalid].filter((fixtureCase) => existsSync(path.join(fixturesDir, validatorId, `${fixtureCase}.ts`)));
}

function factoryById(id: StudioFactoryId): StudioFactory | undefined {
  return studioFactories.find((factory) => factory.id === id);
}

function isStudioFactoryId(value: unknown): value is StudioFactoryId {
  return typeof value === "string" && studioFactories.some((factory) => factory.id === value);
}

function fixtureFiles(value: unknown): StudioFixtureFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((file): file is Record<string, unknown> => isRecord(file))
    .flatMap((file) => {
      if (typeof file.path !== "string" || typeof file.content !== "string") return [];
      return [{ path: normalizeFixturePath(file.path), content: file.content }];
    });
}

function stringOption(options: Record<string, unknown>, key: StudioOptionValue): string {
  const value = optionalStringOption(options, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function optionalStringOption(options: Record<string, unknown>, key: StudioOptionValue): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringListOption(options: Record<string, unknown>, key: StudioOptionValue): string[] {
  const value = options[key];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function regexListOption(options: Record<string, unknown>, key: StudioOptionValue): RegExp[] {
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

function numberOption(options: Record<string, unknown>, key: StudioOptionValue, fallback: number): number {
  const value = options[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return fallback;
}

function booleanOption(options: Record<string, unknown>, key: StudioOptionValue, fallback: boolean): boolean {
  const value = options[key];
  return typeof value === "boolean" ? value : fallback;
}

function severityOption(options: Record<string, unknown>): "error" | "warning" {
  return options[StudioOption.Severity] === StudioSeverity.Error ? StudioSeverity.Error : StudioSeverity.Warning;
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

function relativeImport(fromDir: string, toFile: string): string {
  const value = path.relative(fromDir, toFile).split(path.sep).join("/");
  return value.startsWith(".") ? value : `./${value}`;
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

function studioDiagnostic(message: string) {
  return createOpenCanonDiagnostic({ code: "studio-invalid", message });
}
