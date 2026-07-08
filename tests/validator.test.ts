import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

function createHashHex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function linkWorkspaceTypeScript(rootDir: string): string {
  const source = path.resolve("node_modules/typescript");
  const target = path.join(rootDir, "node_modules/typescript");
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    symlinkSync(source, target, "dir");
  } catch {
    cpSync(source, target, { recursive: true });
  }
  try {
    return JSON.parse(readFileSync(path.join(target, "package.json"), "utf8")).version as string;
  } catch (error) {
    throw new Error(`Could not read linked TypeScript package metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
}
import {
  applyDoctorFixes,
  applyFindingFixes,
  BatchProducerPolicy,
  buildDoctorReport,
  createPaths,
  createCommitApprovalContext,
  createCommitApprovalRecord,
  defineArea,
  createValidationResultCache,
  createRuntime,
  createConventionFactory,
  conventionToValidator,
  defineConvention,
  pickAuthoritativeStatus,
  createValidationContext,
  discoverProjectFiles,
  DoctorStatus,
  flushValidationContextCache,
  FixModeValue,
  generateProjectTypes,
  getChangedFiles,
  loadCommitApprovalsWithDiagnostics,
  ProjectTypesFilePath,
  OpenCanonSkillFilePath,
  renderOpenCanonAgentEntryBlock,
  toPendingCommitGates,
  resolveCommitGates,
  resolveValidators,
  runValidation,
  InteractiveProducerPolicy,
  ValidatorOutcomeStatus,
  LiteralContext,
  LiteralValueKind,
  savePendingCommitGates,
  upsertCommitApproval,
  validateConfig,
  validateContext,
  validateValidatorDefinitions,
  validatorGraphHash,
} from "@opencanon/core";
import type { Convention } from "@opencanon/core";
import type { ValidatorDefinition } from "../packages/core/src/validator-types.ts";
import {
  externalCommand,
  externalDiagnostics,
  noHardcodedConfigValues,
  noSecretLikeLiterals,
  noBypassComments,
  noHeaderComments,
  noUnusedExports,
  migrationReferences,
  repeatedLiterals,
  requireExportPattern,
  requiredFileSibling,
  requiredFunctionParam,
  restrictedSymbols,
  similarFunctionNames,
} from "@opencanon/validators";

function resolveTestValidators(input: unknown) {
  const normalize = (value: unknown) => (isConvention(value) ? conventionToValidator(value) : value);
  return resolveValidators(Array.isArray(input) ? input.map(normalize).filter(Boolean) : normalize(input));
}

function isConvention(value: unknown): value is Convention {
  return Boolean(value && typeof value === "object" && "applies" in value && "render" in value && "runtime" in value);
}

function testValidatorDefinition(definition: ValidatorDefinition): ValidatorDefinition {
  return definition;
}

function isolatedCliEnv(rootDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.OPENCANON_SERVICE_REGISTRY_PATH = path.join(rootDir, "global", "service.json");
  return env;
}

function stopIsolatedCliRuntime(rootDir: string): void {
  const script = path.join(process.cwd(), "packages/cli/src/index.ts");
  const env = isolatedCliEnv(rootDir);
  for (const args of [
    ["project", "stop", "--format", "json"],
    ["service", "stop", "--format", "json"],
  ]) {
    spawnSync(process.execPath, [script, ...args], {
      cwd: rootDir,
      encoding: "utf8",
      env,
      timeout: 15_000,
    });
  }
}

test("validator definitions reject unknown keys generically", () => {
  const diagnostics = validateValidatorDefinitions({
    id: "sample-validator",
    topics: ["sample"],
    severity: "error",
    scope: "file",
    rank: 1,
    validate() {
      return [];
    },
  });

  assert.deepEqual(diagnostics, ["Validator sample-validator has unknown key: rank."]);
});

test("validator definitions require explicit leaf scope and known facts", () => {
  assert.deepEqual(
    validateValidatorDefinitions({
      id: "missing-scope",
      topics: ["sample"],
      severity: "error",
      validate() {
        return [];
      },
    }),
    ["Validator missing-scope needs scope from itself or a parent."],
  );

  assert.deepEqual(
    validateValidatorDefinitions({
      id: "bad-facts",
      topics: ["sample"],
      severity: "error",
      scope: "file",
      facts: ["imports", "unknown"],
      validate() {
        return [];
      },
    }),
    ["Validator bad-facts facts must be known fact kinds: imports, exports, symbols, declarations, calls, literals, comments, references, annotations, diagnostics, duplicates."],
  );
});

test("validator definitions derive generated docs references through factory metadata", () => {
  const customFactory = createConventionFactory<{ in: string[] }>((options) => testValidatorDefinition({
    id: options.id,
    topics: options.topics,
    applies: options.in,
    severity: options.severity,
    scope: "file",
    conventionIds: options.related,
    validate() {
      return [];
    },
  }));

  const resolved = resolveTestValidators(
    customFactory({
      id: "documented-rule",
      topics: ["sample"],
      severity: "warning",
      related: ["sample-decision"],
      docs: ["docs/opencanon/canon/sample.md#sample-decision"],
      in: ["src/**/*.ts"],
    }),
  );

  assert.deepEqual(resolved.diagnostics, []);
  assert.deepEqual(resolved.validators[0].docs, ["docs/opencanon/canon/documented-rule.md#documented-rule"]);
});

test("context validation checks validator convention and docs references", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-context-links-"));
  try {
    mkdirSync(path.join(rootDir, "docs/opencanon/canon"), { recursive: true });
    writeFileSync(path.join(rootDir, "docs/opencanon/canon/architecture.md"), "# Architecture\n\n## Existing Heading\n\nCurrent docs.\n");
    const paths = createPaths(rootDir);
    const diagnostics = validateContext({
      paths,
      conventions: [
        defineConvention({
          id: "current-convention",
          title: "Current convention",
          topics: ["sample"],
          rule: "Sample convention.",
          applies: { kind: "files", globs: ["src/**/*.ts"] },
          render: { kind: "generated", docs: "docs/opencanon/canon/architecture.md#missing-heading", style: "reference" },
          runtime: { kind: "none" },
        }),
      ],
      validators: [
        {
          id: "sample-rule",
          conventionIds: ["missing-convention"],
          docs: ["docs/opencanon/canon/architecture.md#missing-heading"],
        },
      ],
    });

    assert(diagnostics.includes("Convention current-convention generated docs path must not include #<heading-slug>: docs/opencanon/canon/architecture.md#missing-heading"));
    assert(diagnostics.includes("Validator sample-rule references missing convention: missing-convention"));
    assert(diagnostics.includes("Validator sample-rule docs reference points at missing heading: docs/opencanon/canon/architecture.md#missing-heading"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("context validation enforces convention and validator back-references", () => {
  const diagnostics = validateContext({
    conventions: [
      defineConvention({
        id: "convention-a",
        title: "Convention A",
        topics: ["sample"],
        related: ["validator-a"],
        rule: "Convention A.",
        applies: { kind: "files", globs: ["src/**/*.ts"] },
        render: { kind: "none" },
        runtime: { kind: "none" },
      }),
      defineConvention({
        id: "convention-b",
        title: "Convention B",
        topics: ["sample"],
        related: [],
        rule: "Convention B.",
        applies: { kind: "files", globs: ["src/**/*.ts"] },
        render: { kind: "none" },
        runtime: { kind: "none" },
      }),
    ],
    validators: [
      { id: "validator-a", conventionIds: [], docs: [] },
      { id: "validator-b", conventionIds: ["convention-b"], docs: [] },
    ],
  });

  assert(diagnostics.includes("Validator validator-b references convention convention-b, but convention convention-b does not reference validator validator-b."));
});

test("runtime validation reports broken finding docs references", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-finding-docs-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    mkdirSync(path.join(rootDir, "docs/opencanon/canon"), { recursive: true });
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", projectFilePatterns: ["src/**/*.ts"], ignore: [] }));
    writeFileSync(path.join(rootDir, "src/a.ts"), "export const value = true;\n");
    writeFileSync(path.join(rootDir, "docs/opencanon/canon/architecture.md"), "# Architecture\n\n## Existing Heading\n\nCurrent docs.\n");

    const paths = createPaths(rootDir);
    const conventions = [
      defineConvention({
        id: "sample-convention",
        title: "Sample convention",
        topics: ["sample"],
        related: ["broken-doc-finding"],
        rule: "Sample convention.",
        applies: { kind: "files", globs: ["src/**/*.ts"] },
        render: { kind: "none" },
        runtime: { kind: "none" },
      }),
    ];
    const validators = resolveTestValidators(
      testValidatorDefinition({
        id: "broken-doc-finding",
        topics: ["sample"],
        severity: "error",
        scope: "file",
        applies: ["src/**/*.ts"],
        conventionIds: ["sample-convention"],
        validate({ ctx }) {
          return ctx.targetFiles.map((file) =>
            file.report({
              line: 1,
              message: "Finding with broken refs.",
              docs: ["docs/opencanon/canon/architecture.md#missing-heading"],
              conventionIds: ["missing-convention"],
            }),
          );
        },
      }),
    ).validators;

    const result = await runValidation({ rootDir, paths, conventions, validators, files: ["src/a.ts"], producerPolicy: BatchProducerPolicy });
    // Runtime contract violations are `error` outcomes, never findings.
    const runtimeMessages = result.validatorOutcomes
      .filter((outcome) => outcome.status === ValidatorOutcomeStatus.Error)
      .map((outcome) => outcome.reason ?? "");

    assert(runtimeMessages.includes("Finding from broken-doc-finding docs reference points at missing heading: docs/opencanon/canon/architecture.md#missing-heading"));
    assert(runtimeMessages.includes("Finding from broken-doc-finding references missing convention: missing-convention."));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("structured fixes reject paths outside the project root", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-fix-path-"));
  const targetFile = "target.ts";

  try {
    writeFileSync(path.join(rootDir, targetFile), "export const value = 1;\n");
    const result = applyFindingFixes({
      rootDir,
      mode: FixModeValue.Safe,
      dryRun: false,
      findings: [
        {
          validatorId: "unsafe-fix",
          severity: "error",
          file: targetFile,
          line: 1,
          message: "Unsafe fix.",
          fix: {
            safety: "safe",
            description: "Attempt to edit outside the project.",
            edits: [
              {
                file: "../outside.ts",
                range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
                replacement: "export const outside = true;\n",
              },
            ],
          },
        },
      ],
    });

    assert.equal(result.appliedEdits, 0);
    assert(result.diagnostics.some((diagnostic) => diagnostic.includes("Unsafe edit path")));
    assert.equal(readFileSync(path.join(rootDir, targetFile), "utf8"), "export const value = 1;\n");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("validators can emit diff-bound commit gates", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-commit-gate-"));
  const targetFile = "src/auth/session.ts";

  try {
    mkdirSync(path.join(rootDir, "src/auth"), { recursive: true });
    writeFileSync(path.join(rootDir, targetFile), "export const sessionTtl = 60;\n");
    initGitRepo(rootDir);
    writeFileSync(path.join(rootDir, targetFile), "export const sessionTtl = 120;\n");
    git(rootDir, ["add", targetFile]);

    const paths = createPaths(rootDir);
    const validators = resolveTestValidators(
      testValidatorDefinition({
        id: "auth-session-intent",
        topics: ["auth"],
        severity: "warning",
        scope: "file",
        applies: ["src/auth/**"],
        validate({ ctx }) {
          for (const file of ctx.targetFiles) {
            ctx.commitGate({
              id: "auth-session-change",
              title: "Auth session behavior changed",
              reason: "Session lifecycle code changed and needs user intent before commit.",
              question: "Did the user approve the auth session TTL change?",
              file: file.path,
              line: 1,
              evidence: [{ file: file.path, line: 1, message: "sessionTtl changed" }],
            });
          }
          return [];
        },
      }),
    ).validators;

    const result = await runValidation({ rootDir, paths, conventions: [], validators, files: [targetFile], producerPolicy: BatchProducerPolicy });
    assert.equal(result.findings.length, 0);
    assert.equal(result.commitGates.length, 1);
    assert.equal(result.commitGates[0]?.id, "auth-session-change");

    const context = createCommitApprovalContext(paths, result.validatorGraphHash);
    const unresolved = resolveCommitGates(result.commitGates, { version: 1, approvals: [] }, context);
    assert.equal(unresolved[0]?.status, "unresolved");
    const pending = toPendingCommitGates(unresolved);
    assert.equal(pending[0]?.question, "Did the user approve the auth session TTL change?");
    assert.equal(pending[0]?.agentAction, "request_user_input");
    assert.deepEqual(pending[0]?.preferredToolNames, ["request_user_input", "ask_user"]);
    assert.equal(pending[0]?.plainChatFallbackAllowed, true);
    assert.match(pending[0]?.fallbackProtocol ?? "", /pause and ask in chat/);
    assert.equal(pending[0]?.choices[0]?.label, "Approve");
    assert(pending[0]?.agentProtocol.includes("Do not infer approval from the original commit request."));
    assert(pending[0]?.agentProtocol.some((instruction) => instruction.includes("structured ask-user tool")));
    assert.match(pending[0]?.approveCommand ?? "", /gate approve auth-session-change/);

    const approval = createCommitApprovalRecord({
      gate: result.commitGates[0]!,
      summary: "User confirmed the session TTL change is intentional.",
      context,
    });
    const approved = resolveCommitGates(result.commitGates, { version: 1, approvals: [approval] }, context);
    assert.equal(approved[0]?.status, "approved");
    const saved = savePendingCommitGates(paths, { context, gates: unresolved });
    assert.equal(saved.pending.length, 1);
    assert(existsSync(path.join(paths.cacheDir, "commit-gates.json")));
    const upserted = upsertCommitApproval({ version: 1, approvals: [approval] }, approval);
    assert.equal(upserted.approvals.length, 1);

    writeFileSync(path.join(rootDir, targetFile), "export const sessionTtl = 180;\n");
    git(rootDir, ["add", targetFile]);
    const changedContext = createCommitApprovalContext(paths, result.validatorGraphHash);
    const invalidated = resolveCommitGates(result.commitGates, { version: 1, approvals: [approval] }, changedContext);
    assert.equal(invalidated[0]?.status, "unresolved");
    writeFileSync(paths.commitApprovalsPath, "{");
    const malformed = loadCommitApprovalsWithDiagnostics(paths);
    assert.equal(malformed.approvals.approvals.length, 0);
    assert.match(malformed.diagnostics[0] ?? "", /not valid JSON/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("validator graph hash is based on metadata instead of function source", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-validator-hash-"));
  const targetFile = "src/auth/session.ts";

  try {
    mkdirSync(path.join(rootDir, "src/auth"), { recursive: true });
    writeFileSync(path.join(rootDir, targetFile), "export const sessionTtl = 60;\n");
    const paths = createPaths(rootDir);
    const validatorBase = {
      id: "auth-session-hash",
      topics: ["auth"],
      severity: "warning" as const,
      scope: "file" as const,
      applies: ["src/auth/**"],
    };
    const first = resolveTestValidators(
      testValidatorDefinition({
        ...validatorBase,
        validate() {
          return [];
        },
      }),
    ).validators;
    const second = resolveTestValidators(
      testValidatorDefinition({
        ...validatorBase,
        validate({ ctx }) {
          return ctx.targetFiles.length > 100 ? [] : [];
        },
      }),
    ).validators;

    const firstResult = await runValidation({ rootDir, paths, conventions: [], validators: first, files: [targetFile], producerPolicy: BatchProducerPolicy });
    const secondResult = await runValidation({ rootDir, paths, conventions: [], validators: second, files: [targetFile], producerPolicy: BatchProducerPolicy });
    assert.equal(firstResult.validatorGraphHash, secondResult.validatorGraphHash);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("invalid commit gate definitions are validator-runtime error outcomes (not findings)", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-invalid-commit-gate-"));
  const targetFile = "src/auth/session.ts";

  try {
    mkdirSync(path.join(rootDir, "src/auth"), { recursive: true });
    writeFileSync(path.join(rootDir, targetFile), "export const sessionTtl = 60;\n");
    const paths = createPaths(rootDir);
    const validators = resolveTestValidators(
      testValidatorDefinition({
        id: "auth-session-invalid-gate",
        topics: ["auth"],
        severity: "warning",
        scope: "file",
        applies: ["src/auth/**"],
        validate({ ctx }) {
          ctx.commitGate({
            id: "auth-session-change",
            title: "Auth session behavior changed",
            reason: "Session lifecycle code changed and needs user intent before commit.",
            question: "",
          });
          return [];
        },
      }),
    ).validators;

    const result = await runValidation({ rootDir, paths, conventions: [], validators, files: [targetFile], producerPolicy: BatchProducerPolicy });
    assert.equal(result.commitGates.length, 0);
    assert.equal(result.findings.length, 0, "a runtime contract violation is an outcome, not a finding");
    const errorOutcome = result.validatorOutcomes.find((outcome) => outcome.status === ValidatorOutcomeStatus.Error);
    assert.equal(errorOutcome?.validatorId, "auth-session-invalid-gate");
    assert.match(errorOutcome?.reason ?? "", /needs a non-empty question/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a validator that throws is isolated as an error outcome; other validators still run", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-validator-throw-"));
  const targetFile = "src/a.ts";
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, targetFile), "export const x = 1;\n");
    const paths = createPaths(rootDir);
    const validators = resolveTestValidators([
      testValidatorDefinition({
        id: "boom",
        topics: ["isolation"],
        severity: "warning",
        scope: "file",
        applies: ["src/**/*.ts"],
        validate() {
          throw new Error("kaboom");
        },
      }),
      testValidatorDefinition({
        id: "healthy",
        topics: ["isolation"],
        severity: "warning",
        scope: "file",
        applies: ["src/**/*.ts"],
        validate({ ctx }) {
          return ctx.targetFiles.map((file) => file.report({ line: 1, message: "healthy ran" }));
        },
      }),
    ]).validators;

    // The run must NOT reject — one throwing validator cannot abort the whole run.
    const result = await runValidation({ rootDir, paths, conventions: [], validators, files: [targetFile], producerPolicy: BatchProducerPolicy });

    const boom = result.validatorOutcomes.find((outcome) => outcome.validatorId === "boom");
    assert.equal(boom?.status, "error");
    assert.match(boom?.reason ?? "", /validator threw: kaboom/);

    // The healthy validator still produced its finding + a `ran` outcome.
    assert.equal(result.findings.filter((finding) => finding.validatorId === "healthy").length, 1);
    assert.equal(result.validatorOutcomes.find((outcome) => outcome.validatorId === "healthy")?.status, "ran");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("file-less commit gate approvals bind to gate identity", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-commit-gate-identity-"));
  const targetFile = "src/auth/session.ts";

  try {
    mkdirSync(path.join(rootDir, "src/auth"), { recursive: true });
    writeFileSync(path.join(rootDir, targetFile), "export const sessionTtl = 60;\n");
    initGitRepo(rootDir);
    writeFileSync(path.join(rootDir, targetFile), "export const sessionTtl = 120;\n");
    git(rootDir, ["add", targetFile]);

    const paths = createPaths(rootDir);
    const baseGate = {
      id: "auth-session-change",
      validatorId: "auth-session-intent",
      title: "Auth session behavior changed",
      reason: "Session lifecycle code changed and needs user intent before commit.",
      question: "Did the user approve the auth session TTL change?",
    };
    const context = createCommitApprovalContext(paths, "validator-graph");
    const approval = createCommitApprovalRecord({
      gate: baseGate,
      summary: "User confirmed the session TTL change is intentional.",
      context,
    });

    assert.equal(resolveCommitGates([baseGate], { version: 1, approvals: [approval] }, context)[0]?.status, "approved");
    assert.equal(
      resolveCommitGates([{ ...baseGate, reason: "Different user intent question for the same staged diff." }], { version: 1, approvals: [approval] }, context)[0]
        ?.status,
      "unresolved",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("file-scoped commit gate approvals bind to current file content", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-file-commit-gate-"));
  const targetFile = "src/auth/session.ts";

  try {
    mkdirSync(path.join(rootDir, "src/auth"), { recursive: true });
    writeFileSync(path.join(rootDir, targetFile), "export const sessionTtl = 60;\n");
    initGitRepo(rootDir);
    writeFileSync(path.join(rootDir, targetFile), "export const sessionTtl = 120;\n");
    git(rootDir, ["add", targetFile]);

    const paths = createPaths(rootDir);
    const validators = resolveTestValidators(
      testValidatorDefinition({
        id: "auth-session-file-intent",
        topics: ["auth"],
        severity: "warning",
        scope: "file",
        applies: ["src/auth/**"],
        validate({ ctx }) {
          for (const file of ctx.targetFiles) {
            ctx.commitGate({
              id: "auth-session-file-change",
              title: "Auth session file changed",
              reason: "The full auth session file content needs user intent before commit.",
              question: "Did the user approve the current auth session file content?",
              approvalScope: "file",
              file: file.path,
              line: 1,
            });
          }
          return [];
        },
      }),
    ).validators;

    const result = await runValidation({ rootDir, paths, conventions: [], validators, files: [targetFile], producerPolicy: BatchProducerPolicy });
    const context = createCommitApprovalContext(paths, result.validatorGraphHash);
    const approval = createCommitApprovalRecord({
      gate: result.commitGates[0]!,
      summary: "User confirmed the current auth session file content.",
      context,
    });

    assert.equal(resolveCommitGates(result.commitGates, { version: 1, approvals: [approval] }, context)[0]?.status, "approved");

    writeFileSync(path.join(rootDir, targetFile), "export const sessionTtl = 180;\n");
    const changedContext = createCommitApprovalContext(paths, result.validatorGraphHash);
    assert.equal(resolveCommitGates(result.commitGates, { version: 1, approvals: [approval] }, changedContext)[0]?.status, "unresolved");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("structured fixes expose command fixes without executing them", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-fix-command-"));
  try {
    writeFileSync(path.join(rootDir, "target.ts"), "export const value = 1;\n");
    const result = applyFindingFixes({
      rootDir,
      mode: FixModeValue.Suggested,
      dryRun: false,
      findings: [
        {
          validatorId: "command-fix",
          severity: "warning",
          file: "target.ts",
          line: 1,
          message: "Run formatter.",
          fix: {
            safety: "suggested",
            description: "Run the project formatter.",
            command: "npm run format",
          },
        },
      ],
    });

    assert.equal(result.appliedEdits, 0);
    assert.equal(result.skipped[0].reason, "Fix command is advisory and is not auto-executed: npm run format");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("validator summary callbacks resolve from effective metadata", () => {
  const resolved = resolveTestValidators(
    testValidatorDefinition({
      id: "parent-rule",
      topics: ["parent"],
      applies: ["src/**"],
      severity: "warning",
      scope: "file",
      facts: ["imports"],
      conventionIds: ["parent-decision"],
      validators: [
        testValidatorDefinition({
          id: "child-rule",
          topics: ["child"],
          applies: ["**/*.ts"],
          conventionIds: ["child-decision"],
          summary: ({ id, topics, applies, severity, scope, facts, conventionIds }) =>
            `${id} ${topics.join("+")} ${applies.join("|")} ${severity} ${scope} ${facts.join("+")} ${conventionIds.join("+")}`,
          validate() {
            return [];
          },
        }),
      ],
    }),
  );

  assert.deepEqual(resolved.diagnostics, []);
  assert.equal(resolved.validators[0].summary, "child-rule parent+child src/** && **/*.ts warning file imports parent-decision+child-decision");
});

test("validator summary callback failures are definition diagnostics", () => {
  const diagnostics = validateValidatorDefinitions({
    id: "sample-validator",
    topics: ["sample"],
    severity: "error",
    scope: "file",
    summary() {
      throw new Error("boom");
    },
    validate() {
      return [];
    },
  });

  assert.deepEqual(diagnostics, ["Validator sample-validator summary function failed: boom"]);
});

test("createConventionFactory returns conventions adapted to validator definitions", async () => {
  const noDebugFlag = createConventionFactory<{ in: string[] }>(({ id, topics, severity, related, docs, in: applies }) => ({
    id,
    topics,
    severity,
    scope: "file",
    conventionIds: related,
    applies,
    validate({ ctx }) {
      return ctx.targetFiles.flatMap((file) =>
        file.find("debugger").map((match) =>
          file.report({
            line: match.line,
            column: match.column,
            message: "Debug statements are not allowed.",
            docs,
          }),
        ),
      );
    },
  }));

  const definition = noDebugFlag({
    id: "no-debugger",
    topics: ["hygiene"],
    severity: "warning",
    related: ["comments-current"],
    docs: ["docs/opencanon/canon/lifecycle.md#comments"],
    in: ["src/**/*.{ts,tsx}"],
  });
  const resolved = resolveTestValidators(definition);
  assert.deepEqual(resolved.diagnostics, []);
  assert.equal(resolved.validators.length, 1);
  assert.equal(resolved.validators[0].id, "no-debugger");
  assert.equal(resolved.validators[0].scope, "file");
  assert.deepEqual(resolved.validators[0].topics, ["hygiene"]);
  assert.deepEqual(resolved.validators[0].conventionIds, ["no-debugger", "comments-current"]);

  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-factory-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/company.ts"), "debugger;\n");
    const ctx = createValidationContext({
      rootDir,
      files: ["src/company.ts"],
      targetFiles: ["src/company.ts"],
      validator: resolved.validators[0],
    });

    const findings = await resolved.validators[0].validate({ ctx, runtime: createRuntime(createPaths(rootDir), []) });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].validatorId, "no-debugger");
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].docs?.[0], "docs/opencanon/canon/lifecycle.md#comments");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("validation context exposes graph callers and callees", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-graph-context-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "src/company.ts"),
      ["export function loadCompany() {", "  return true;", "}", "", "export function renderCompany() {", "  return loadCompany();", "}", ""].join("\n"),
    );
    const ctx = createValidationContext({
      rootDir,
      files: ["src/company.ts"],
      targetFiles: ["src/company.ts"],
      validator: { id: "graph-context", severity: "warning" },
    });

    const callers = ctx.graph.callers("loadCompany");
    assert.equal(callers.length, 1);
    assert.equal(callers[0].source?.name, "renderCompany");
    assert.equal(callers[0].target.name, "loadCompany");
    assert.equal(callers[0].kind, "call");
    assert.equal(callers[0].confidence, "exact");

    const callees = ctx.graph.callees("renderCompany");
    assert.equal(callees.length, 1);
    assert.equal(callees[0].target.name, "loadCompany");
    assert.equal(ctx.graph.impact("loadCompany").length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("validator analysis globs expose cross-scope project files", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-analysis-scope-"));
  try {
    mkdirSync(path.join(rootDir, "generated/contracts"), { recursive: true });
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), "{\"type\":\"module\"}\n");
    writeFileSync(path.join(rootDir, "src/service.ts"), "export const contract = 'company';\n");
    writeFileSync(path.join(rootDir, "generated/contracts/company.json"), "{\"name\":\"company\"}\n");
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "filesystem",
        projectFilePatterns: ["src/**/*.ts", "generated/contracts/**/*.json"],
      }),
    );

    const paths = createPaths(rootDir);
    const validator = testValidatorDefinition({
      id: "contract-manifest-parity",
      topics: ["contracts"],
      applies: ["src/**/*.ts"],
      analysis: ["generated/contracts/**/*.json"],
      severity: "error",
      scope: "project",
      validate({ ctx }) {
        assert.deepEqual(ctx.targetFiles.map((file) => file.path), ["src/service.ts"]);
        assert(ctx.files.some((file) => file.path === "generated/contracts/company.json"));
        assert(ctx.projectFiles(["generated/contracts/**/*.json"]).some((file) => file.path === "generated/contracts/company.json"));
        return [];
      },
    });

    const result = await runValidation({
      rootDir,
      paths,
      conventions: [],
      validators: resolveTestValidators(validator).validators,
      files: ["src/service.ts"],
      producerPolicy: BatchProducerPolicy,
    });

    assert.equal(result.findingCount, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("noUnusedExports reports exported symbols without graph callers", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-unused-export-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "src/company.ts"),
      ["export function usedCompany() {", "  return true;", "}", "", "export function unusedCompany() {", "  return false;", "}", ""].join("\n"),
    );
    writeFileSync(path.join(rootDir, "src/route.ts"), "import { usedCompany } from './company';\nusedCompany();\n");
    const validator = noUnusedExports({
      id: "no-unused-exports",
      topics: ["dead-code"],
      severity: "warning",
      in: ["src/**/*.ts"],
      message: "Exported symbol has no known project caller.",
    });
    const resolved = resolveTestValidators(validator);
    assert.deepEqual(resolved.diagnostics, []);
    const [definition] = resolved.validators;
    const ctx = createValidationContext({
      rootDir,
      files: ["src/company.ts", "src/route.ts"],
      targetFiles: ["src/company.ts", "src/route.ts"],
      validator: definition,
    });

    const findings = await definition.validate({ ctx, runtime: createRuntime(createPaths(rootDir), []) });
    assert.deepEqual(
      findings.map((finding) => `${finding.file}:${finding.line}:${finding.message}`),
      ["src/company.ts:5:Exported symbol has no known project caller."],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("noUnusedExports ignores configured public surfaces", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-unused-public-surface-"));
  try {
    mkdirSync(path.join(rootDir, "src/api"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/api/public.ts"), "export function publicCompany() { return true; }\n");
    writeFileSync(path.join(rootDir, "src/internal.ts"), "export function internalCompany() { return false; }\n");
    const validator = resolveTestValidators(
      noUnusedExports({
        id: "no-unused-exports",
        topics: ["dead-code"],
        severity: "warning",
        in: ["src/**/*.ts"],
        publicSurfaces: ["src/api/**"],
        message: "Exported symbol has no known project caller.",
      }),
    ).validators[0];
    const ctx = createValidationContext({
      rootDir,
      files: ["src/api/public.ts", "src/internal.ts"],
      targetFiles: ["src/api/public.ts", "src/internal.ts"],
      validator,
    });

    const findings = await validator.validate({ ctx, runtime: createRuntime(createPaths(rootDir), []) });
    assert.deepEqual(
      findings.map((finding) => `${finding.file}:${finding.line}:${finding.message}`),
      ["src/internal.ts:1:Exported symbol has no known project caller."],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("migrationReferences downgrades baseline-known matches", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-migration-ref-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/old.ts"), "oldApi();\noldApi();\n");
    const validator = resolveTestValidators(
      migrationReferences({
        id: "old-api-migration",
        topics: ["migration"],
        severity: "error",
        in: ["src/**/*.ts"],
        pattern: "\\boldApi\\(",
        message: "oldApi is replaced; use currentApi.",
      }),
    ).validators[0];
    const ctx = createValidationContext({
      rootDir,
      paths: createPaths(rootDir),
      files: ["src/old.ts"],
      targetFiles: ["src/old.ts"],
      validator,
    });
    const first = await validator.validate({ ctx, runtime: createRuntime(createPaths(rootDir), []) });
    assert.deepEqual(first.map((finding) => finding.severity), ["error", "error"]);

    mkdirSync(path.join(rootDir, ".opencanon"), { recursive: true });
    writeFileSync(
      path.join(rootDir, ".opencanon/baseline.json"),
      JSON.stringify({ version: 1, findings: [{ key: "old-api-migration\u0000src/old.ts\u00001\u0000oldApi is replaced; use currentApi.", validatorId: "old-api-migration", file: "src/old.ts", line: 1, message: "oldApi is replaced; use currentApi." }] }),
    );
    const knownCtx = createValidationContext({
      rootDir,
      paths: createPaths(rootDir),
      files: ["src/old.ts"],
      targetFiles: ["src/old.ts"],
      validator,
    });
    const next = await validator.validate({ ctx: knownCtx, runtime: createRuntime(createPaths(rootDir), []) });
    assert.deepEqual(next.map((finding) => finding.severity), ["warning", "error"]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("migrationReferences can emit structured replacement fixes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-migration-fix-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/old.ts"), "oldApi();\n");
    const validator = resolveTestValidators(
      migrationReferences({
        id: "old-api-migration",
        topics: ["migration"],
        severity: "error",
        in: ["src/**/*.ts"],
        pattern: "\\boldApi",
        replacement: "currentApi",
        fixSafety: "safe",
        message: "oldApi is replaced; use currentApi.",
      }),
    ).validators[0];
    const ctx = createValidationContext({
      rootDir,
      paths: createPaths(rootDir),
      files: ["src/old.ts"],
      targetFiles: ["src/old.ts"],
      validator,
    });
    const findings = await validator.validate({ ctx, runtime: createRuntime(createPaths(rootDir), []) });
    const fix = applyFindingFixes({ rootDir, findings, mode: FixModeValue.Safe, dryRun: false });

    assert.equal(fix.appliedEdits, 1);
    assert.equal(readFileSync(path.join(rootDir, "src/old.ts"), "utf8"), "currentApi();\n");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("similarFunctionNames reports graph-backed likely DRY overlaps", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-similar-functions-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "src/company.ts"),
      [
        "function normalizeCompany() { return true; }",
        "export function loadCompany() {",
        "  return normalizeCompany();",
        "}",
        "export function fetchCompany() {",
        "  return normalizeCompany();",
        "}",
        "",
      ].join("\n"),
    );
    const validator = resolveTestValidators(
      similarFunctionNames({
        id: "similar-functions",
        topics: ["dry"],
        severity: "warning",
        in: ["src/**/*.ts"],
        requireSharedCallees: true,
        message: "Similar function surfaces may duplicate behavior.",
      }),
    ).validators[0];
    const ctx = createValidationContext({
      rootDir,
      files: ["src/company.ts"],
      targetFiles: ["src/company.ts"],
      validator,
    });
    const findings = await validator.validate({ ctx, runtime: createRuntime(createPaths(rootDir), []) });

    assert.deepEqual(
      findings.map((finding) => `${finding.file}:${finding.line}:${finding.message}`),
      ["src/company.ts:2:Similar function surfaces may duplicate behavior. Similar functions: loadCompany and fetchCompany share callees normalizeCompany."],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("curated validators cover function params, siblings, and exports", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-curated-"));
  try {
    mkdirSync(path.join(rootDir, "src/services"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/services/company.service.ts"), "export function loadCompany(id: string) {\n  return id;\n}\n");
    const validators = resolveTestValidators([
      requiredFunctionParam({
        id: "require-tx-param",
        topics: ["dal"],
        severity: "error",
        in: ["src/services/**/*.ts"],
        functions: /^load/,
        param: /\btx\??\s*:/,
        position: "last",
        message: "Function should accept tx as the final parameter.",
      }),
      requiredFileSibling({
        id: "require-test-sibling",
        topics: ["tests"],
        severity: "warning",
        in: ["src/services/**/*.ts"],
        sibling: "{stem}.test.{ext}",
        message: "Service should have a sibling test file.",
      }),
      requireExportPattern({
        id: "require-service-export",
        topics: ["exports"],
        severity: "error",
        in: ["src/services/**/*.ts"],
        names: /Service$/,
        kinds: ["function", "const"],
        message: "Service file should export a *Service symbol.",
      }),
    ]);
    assert.deepEqual(validators.diagnostics, []);

    const findings = [];
    for (const validator of validators.validators) {
      const ctx = createValidationContext({
        rootDir,
        files: ["src/services/company.service.ts"],
        targetFiles: ["src/services/company.service.ts"],
        validator,
      });
      findings.push(...(await validator.validate({ ctx, runtime: createRuntime(createPaths(rootDir), []) })));
    }

    assert.deepEqual(
      findings.map((finding) => finding.validatorId).sort(),
      ["require-service-export", "require-test-sibling", "require-tx-param"],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("comment policy validators block headers and bypass comments", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-comments-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/header.ts"), "// This file contains company helpers.\nexport const company = {};\n");
    writeFileSync(path.join(rootDir, "src/license.ts"), "// SPDX-License-Identifier: MIT\nexport const license = true;\n");
    writeFileSync(path.join(rootDir, "src/bypass.ts"), "export const value = 1;\n// eslint-disable-next-line no-console\nconsole.log(value);\n");
    writeFileSync(path.join(rootDir, "src/approved.ts"), "export const value = 1;\n// eslint-disable-next-line no-console APPROVED-123\nconsole.log(value);\n");

    const resolved = resolveTestValidators([
      noHeaderComments({
        id: "no-header-comments",
        topics: ["comments"],
        severity: "warning",
        in: ["src/**/*.ts"],
        message: "Remove header comments.",
      }),
      noBypassComments({
        id: "no-bypass-comments",
        topics: ["comments"],
        severity: "error",
        in: ["src/**/*.ts"],
        message: "Bypass comments are not allowed.",
      }),
      noBypassComments({
        id: "bypass-requires-ticket",
        topics: ["comments"],
        severity: "warning",
        in: ["src/**/*.ts"],
        requireReason: true,
        reasonPatterns: /APPROVED-[0-9]+/,
        message: "Bypass comments need an approved ticket.",
      }),
    ]);
    assert.deepEqual(resolved.diagnostics, []);

    const findings = [];
    for (const validator of resolved.validators) {
      const ctx = createValidationContext({
        rootDir,
        files: ["src/header.ts", "src/license.ts", "src/bypass.ts", "src/approved.ts"],
        targetFiles: ["src/header.ts", "src/license.ts", "src/bypass.ts", "src/approved.ts"],
        analysisFiles: ["src/header.ts", "src/license.ts", "src/bypass.ts", "src/approved.ts"],
        validator,
      });
      findings.push(...(await validator.validate({ ctx, runtime: createRuntime(createPaths(rootDir), []) })));
    }

    assert.deepEqual(
      findings.map((finding) => [finding.validatorId, finding.file, finding.line]).sort(),
      [
        ["bypass-requires-ticket", "src/bypass.ts", 2],
        ["no-bypass-comments", "src/approved.ts", 2],
        ["no-bypass-comments", "src/bypass.ts", 2],
        ["no-header-comments", "src/header.ts", 1],
      ],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project discovery uses git ignore rules", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-git-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), "{\"type\":\"module\"}\n");
    writeFileSync(path.join(rootDir, ".gitignore"), "src/generated.ts\n");
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = {};\n");
    writeFileSync(path.join(rootDir, "src/generated.ts"), "export const generated = {};\n");
    spawnSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });

    const result = discoverProjectFiles(createPaths(rootDir));

    assert.equal(result.source, "git");
    assert.equal(result.failed, false);
    assert.deepEqual(result.files, ["package.json", "src/company.ts"]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("changed file discovery ignores unchanged and deleted tracked files", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-changed-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), "{\"type\":\"module\"}\n");
    writeFileSync(path.join(rootDir, "src/deleted.ts"), "export const deleted = true;\n");
    writeFileSync(path.join(rootDir, "src/modified.ts"), "export const modified = false;\n");
    writeFileSync(path.join(rootDir, "src/unchanged.ts"), "export const unchanged = true;\n");
    spawnSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: rootDir, stdio: "ignore" });
    spawnSync("git", ["config", "user.name", "OpenCanon Test"], { cwd: rootDir, stdio: "ignore" });
    spawnSync("git", ["add", "."], { cwd: rootDir, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: rootDir, stdio: "ignore" });

    rmSync(path.join(rootDir, "src/deleted.ts"));
    writeFileSync(path.join(rootDir, "src/modified.ts"), "export const modified = true;\n");
    writeFileSync(path.join(rootDir, "src/untracked.ts"), "export const untracked = true;\n");

    const result = getChangedFiles(rootDir);

    assert.deepEqual(result.files, ["src/modified.ts", "src/untracked.ts"]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("default project discovery uses filesystem outside Git repos", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-no-git-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), "{\"type\":\"module\"}\n");
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = {};\n");

    const result = discoverProjectFiles(createPaths(rootDir));

    assert.equal(result.source, "filesystem");
    assert.equal(result.failed, false);
    assert.deepEqual(result.files, ["package.json", "src/company.ts"]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("explicit git discovery fails without filesystem fallback", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-config-git-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), "{\"type\":\"module\"}\n");
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "git" }));

    const paths = createPaths(rootDir);
    const result = discoverProjectFiles(paths);
    const diagnostics = validateConfig(paths);

    assert.equal(result.source, "git");
    assert.equal(result.failed, true);
    assert(diagnostics.some((diagnostic) => diagnostic.includes("no Git repository")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("config validation rejects stale unknown fields", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-config-unknown-"));
  try {
    const staleField = "sections" + "Path";
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "filesystem",
        [staleField]: "unused",
      }),
    );

    const diagnostics = validateConfig(createPaths(rootDir));

    assert(diagnostics.includes(`Unknown config field: ${staleField}.`));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project discovery applies max file size guardrail", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-limits-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "filesystem",
        maxFileSizeKb: 1,
        projectFilePatterns: ["src/**/*.ts", "package.json"],
        ignore: ["node_modules/**", ".git/**"],
      }),
    );
    writeFileSync(path.join(rootDir, "src/small.ts"), "export const small = true;\n");
    writeFileSync(path.join(rootDir, "src/large.ts"), `export const large = "${"x".repeat(2048)}";\n`);

    const result = discoverProjectFiles(createPaths(rootDir));

    assert.equal(result.failed, false);
    assert.deepEqual(result.files, ["src/small.ts"]);
    assert(result.diagnostics.some((diagnostic) => diagnostic.includes("large.ts")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("parser cache is written on demand", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-cache-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), "{\"type\":\"module\"}\n");
    writeFileSync(path.join(rootDir, "src/company.ts"), "import { value } from './value';\nexport const company = value;\n");
    writeFileSync(path.join(rootDir, "src/value.ts"), "export const value = 1;\n");
    const paths = createPaths(rootDir);
    const cachePath = path.join(rootDir, ".opencanon/cache/analysis.json");

    const ctx = createValidationContext({
      rootDir,
      paths,
      files: ["src/company.ts", "src/value.ts"],
      targetFiles: ["src/company.ts"],
      analysisFiles: ["src/company.ts"],
      validator: { id: "sample-validator", severity: "error" },
    });

    assert.equal(existsSync(cachePath), false);
    assert.equal(ctx.imports().length, 1);
    flushValidationContextCache(ctx);
    assert.equal(existsSync(cachePath), true);
    assert(readFileSync(cachePath, "utf8").includes("ts.imports"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("validation result cache reuses unchanged validator results", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-validation-cache-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", projectFilePatterns: ["src/**/*.ts"], ignore: [] }));
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const value = 'bad';\n");
    const paths = createPaths(rootDir);
    const cachePath = path.join(rootDir, ".opencanon/cache/validation-results.json");
    let runs = 0;

    const validators = resolveTestValidators(
      testValidatorDefinition({
        id: "cached-validator",
        applies: ["src/**/*.ts"],
        severity: "error",
        scope: "file",
        validate({ ctx }) {
          runs += 1;
          return ctx.targetFiles.flatMap((file) => (file.text.includes("bad") ? [file.report({ line: 1, message: `bad value run ${runs}` })] : []));
        },
      }),
    ).validators;

    const resultCache = createValidationResultCache(paths);
    const first = await runValidation({ rootDir, paths, conventions: [], validators, files: ["src/company.ts"], producerPolicy: BatchProducerPolicy, resultCache });
    assert.equal(runs, 1);
    assert.equal(first.findings[0]?.message, "bad value run 1");
    assert.equal(existsSync(cachePath), true);

    const second = await runValidation({ rootDir, paths, conventions: [], validators, files: ["src/company.ts"], producerPolicy: BatchProducerPolicy, resultCache });
    assert.equal(runs, 1, "unchanged validation should be served from cache");
    assert.equal(second.findings[0]?.message, "bad value run 1");

    writeFileSync(path.join(rootDir, "src/company.ts"), "export const value = 'clean-enough';\n");
    const third = await runValidation({ rootDir, paths, conventions: [], validators, files: ["src/company.ts"], producerPolicy: BatchProducerPolicy, resultCache });
    assert.equal(runs, 2, "changing project input must invalidate the cached validator result");
    assert.equal(third.findings.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("validation result cache invalidates when validator source changes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-validation-cache-source-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", projectFilePatterns: ["src/**/*.ts"], ignore: [] }));
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const value = 'bad';\n");
    const paths = createPaths(rootDir);
    let secondRuns = 0;

    const firstValidators = resolveTestValidators(
      testValidatorDefinition({
        id: "source-sensitive-validator",
        applies: ["src/**/*.ts"],
        severity: "error",
        scope: "file",
        validate({ ctx }) {
          return ctx.targetFiles.map((file) => file.report({ line: 1, message: "first implementation" }));
        },
      }),
    ).validators;
    const secondValidators = resolveTestValidators(
      testValidatorDefinition({
        id: "source-sensitive-validator",
        applies: ["src/**/*.ts"],
        severity: "error",
        scope: "file",
        validate() {
          secondRuns += 1;
          return [];
        },
      }),
    ).validators;

    assert.equal(validatorGraphHash(firstValidators), validatorGraphHash(secondValidators));
    const resultCache = createValidationResultCache(paths);
    const first = await runValidation({ rootDir, paths, conventions: [], validators: firstValidators, files: ["src/company.ts"], producerPolicy: BatchProducerPolicy, resultCache });
    assert.equal(first.findings[0]?.message, "first implementation");

    const second = await runValidation({ rootDir, paths, conventions: [], validators: secondValidators, files: ["src/company.ts"], producerPolicy: BatchProducerPolicy, resultCache });
    assert.equal(secondRuns, 1, "validator source changes must bypass cached results even when graph hash metadata is unchanged");
    assert.equal(second.findings.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("context reads structured files and resolves svelte, alias, and workspace imports", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-workspace-"));
  try {
    mkdirSync(path.join(rootDir, "apps/web/src/lib"), { recursive: true });
    mkdirSync(path.join(rootDir, "packages/common/src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "root", type: "module", workspaces: ["apps/*", "packages/*"] }));
    writeFileSync(path.join(rootDir, "apps/web/package.json"), JSON.stringify({ name: "@demo/web", dependencies: { "@demo/common": "workspace:*" } }));
    writeFileSync(
      path.join(rootDir, "apps/web/tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "$lib/*": ["src/lib/*"],
          },
        },
      }),
    );
    writeFileSync(
      path.join(rootDir, "apps/web/src/App.svelte"),
      [
        "<script lang=\"ts\">",
        "  import { commonValue } from '@demo/common';",
        "  import { localValue } from '$lib/store';",
        "  export const appValue = commonValue + localValue;",
        "</script>",
      ].join("\n"),
    );
    writeFileSync(path.join(rootDir, "apps/web/src/lib/store.ts"), "export const localValue = 1;\n");
    writeFileSync(
      path.join(rootDir, "packages/common/package.json"),
      JSON.stringify({ name: "@demo/common", exports: { ".": "./src/index.ts" } }),
    );
    writeFileSync(path.join(rootDir, "packages/common/src/index.ts"), "export const commonValue = 1;\n");

    const paths = createPaths(rootDir);
    const ctx = createValidationContext({
      rootDir,
      paths,
      targetFiles: ["apps/web/src/App.svelte"],
      analysisFiles: ["apps/web/src/App.svelte"],
      validator: { id: "sample-validator", severity: "error" },
    });

    assert.equal(ctx.json<{ name: string }>("apps/web/package.json").data?.name, "@demo/web");
    assert(ctx.jsonFiles<{ name: string }>(["**/package.json"]).some((item) => item.data?.name === "@demo/common"));
    assert.equal(ctx.workspace().byName("@demo/web")?.kind, "app");
    assert.equal(ctx.workspace().ownerOf("packages/common/src/index.ts")?.name, "@demo/common");

    const imports = ctx.imports();
    assert.deepEqual(
      imports.map((edge) => [edge.source, edge.resolution, edge.resolvedPath, edge.toPackage]),
      [
        ["@demo/common", "workspace", "packages/common/src/index.ts", "@demo/common"],
        ["$lib/store", "alias", "apps/web/src/lib/store.ts", "@demo/web"],
      ],
    );
    assert.equal(imports[0].line, 2);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("typescript literal parser powers repeated literal validators", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-literals-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "src/company.ts"),
      [
        "import { value } from './value';",
        "export const CompanyStatus = {",
        "  ACTIVE: \"active\",",
        "} as const;",
        "export function isActive(status: string) {",
        "  return status === \"active\";",
        "}",
        "export function activeFilter() {",
        "  return { status: \"active\" };",
        "}",
        "export function loadActiveCompany() {",
        "  return findByStatus(\"active\");",
        "}",
        "export const stringNumber = \"123\";",
        "export const realNumber = 123;",
        "export const stringBoolean = \"true\";",
        "export const realBoolean = true;",
      ].join("\n"),
    );

    const validator = resolveTestValidators(
      repeatedLiterals({
        id: "repeated-domain-literals",
        topics: ["type-patterns"],
        severity: "warning",
        in: ["src/**/*.ts"],
        minOccurrences: 3,
        message: "Repeated domain literal.",
      }),
    ).validators[0];
    const ctx = createValidationContext({
      rootDir,
      files: ["src/company.ts"],
      targetFiles: ["src/company.ts"],
      analysisFiles: ["src/company.ts"],
      validator,
    });

    const activeContexts = ctx.file("src/company.ts")?.ts.literals()
      .filter((literal) => literal.value === "active")
      .map((literal) => literal.context)
      .sort();
    assert.deepEqual(activeContexts, ["argument", "comparison", "const-object", "object-property"]);

    const primitiveLiterals = ctx.file("src/company.ts")?.ts.literals()
      .filter((literal) => literal.value === "123" || literal.value === "true")
      .map((literal) => [literal.value, literal.valueKind, literal.line])
      .sort();
    assert.deepEqual(primitiveLiterals, [
      ["123", "number", 15],
      ["123", "string", 14],
      ["true", "boolean", 17],
      ["true", "string", 16],
    ]);

    const findings = await validator.validate({ ctx, runtime: createRuntime(createPaths(rootDir), []) });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert(findings[0].message.includes("\"active\" appears 3 times"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("security literal validators flag secrets and environment config", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-security-literals-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    mkdirSync(path.join(rootDir, "packages/core/src"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "src/config.ts"),
      [
        "export const apiKey = \"not-a-real-secret-value\";",
        "export const placeholder = \"<generated-token>\";",
        "export const callbackUrl = \"https://api.example.com/callback\";",
        "export const safeName = \"company\";",
        "export const localPort = 4767;",
        "export const buttonClassName = \"inline-flex shrink-0 items-center ring-[3px] shadow-xs token-list\";",
        "export const generatedAccessToken = \"N8f7a2b9C4d6e8f0A1b3c5d7E9f1a2b4C6d8e0f2A4b6c8d0\";",
      ].join("\n"),
    );
    writeFileSync(
      path.join(rootDir, "packages/core/src/release-keys.ts"),
      [
        "export const trustedReleaseKeys = [",
        "  {",
        "    keyId: \"35c13edde67e0599c6107376a48b2cd8ee09e4570d8afc8c329e7b4a75d852ce\",",
        "    publicKeySpkiBase64: \"MCowBQYDK2VwAyEAe71w6rTamrI19nnyavUjeEEN2YLJj/h9rljD35sRLPE=\",",
        "  },",
        "];",
        "export const privateKey = \"-----BEGIN PRIVATE KEY-----\";",
      ].join("\n"),
    );

    const secretValidator = resolveTestValidators(
      noSecretLikeLiterals({
        id: "no-secret-like-literals",
        topics: ["security"],
        severity: "error",
        in: ["src/**/*.ts", "packages/*/src/**/*.ts"],
        allowNamedLiterals: [
          {
            in: ["packages/core/src/release-keys.ts"],
            names: ["keyId", "publicKeySpkiBase64"],
          },
        ],
        message: "Secret-like literals must not be committed.",
      }),
    ).validators[0];
    const configValidator = resolveTestValidators(
      noHardcodedConfigValues({
        id: "no-hardcoded-config-values",
        topics: ["configuration"],
        severity: "warning",
        in: ["src/**/*.ts"],
        allow: ["https://api.example.com/callback"],
        message: "Environment-specific config should not be hardcoded.",
      }),
    ).validators[0];
    const ctx = createValidationContext({
      rootDir,
      files: ["src/config.ts", "packages/core/src/release-keys.ts"],
      targetFiles: ["src/config.ts", "packages/core/src/release-keys.ts"],
      analysisFiles: ["src/config.ts", "packages/core/src/release-keys.ts"],
      validator: secretValidator,
    });

    const runtime = createRuntime(createPaths(rootDir), []);
    const secretFindings = await secretValidator.validate({ ctx, runtime });
    assert.deepEqual(
      secretFindings.map((finding) => [finding.file, finding.line]),
      [
        ["src/config.ts", 1],
        ["src/config.ts", 7],
        ["packages/core/src/release-keys.ts", 7],
      ],
    );
    assert.equal(secretFindings[0].severity, secretValidator.severity);
    assert(secretFindings.every((finding) => finding.severity === secretFindings[0].severity));

    const configCtx = createValidationContext({
      rootDir,
      files: ["src/config.ts"],
      targetFiles: ["src/config.ts"],
      analysisFiles: ["src/config.ts"],
      validator: configValidator,
    });
    const configFindings = await configValidator.validate({ ctx: configCtx, runtime });
    assert.equal(configFindings.length, 1);
    assert.equal(configFindings[0].severity, "warning");
    assert.equal(configFindings[0].line, 5);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("validator runtime context exposes deterministic project coverage", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-context-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    mkdirSync(path.join(rootDir, "docs/opencanon"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/billing.ts"), "export const invoice = 'paid';\n");
    writeFileSync(
      path.join(rootDir, "docs/opencanon/impact-surfaces.json"),
      JSON.stringify([
        {
          id: "billing-surface",
          title: "Billing Surface",
          applies: ["src/billing.ts"],
          conventionIds: ["billing-convention"],
          changePolicy: {
            requiresTests: ["tests/billing.test.ts"],
            requiresDocs: [],
            requiresApproval: false,
            reviewers: [],
          },
        },
      ]),
    );

    const paths = createPaths(rootDir);
    const convention = defineConvention({
      id: "billing-convention",
      title: "Billing Convention",
      rule: "Billing source stays governed.",
      topics: ["billing"],
      applies: { kind: "files", globs: ["src/**/*.ts"] },
      render: { kind: "none" },
      runtime: {
        kind: "validator",
        severity: "warning",
        scope: "file",
        facts: [],
        validate() {
          return [];
        },
      },
    });
    const area = defineArea({
      id: "billing-context",
      title: "Billing Context",
      summary: "Billing source is covered by Project Context.",
      surfaces: ["billing-surface"],
      owns: [{ kind: "file", path: "src/billing.ts" }],
      checks: [{ id: "billing-test", kind: "test", target: "tests/billing.test.ts" }],
      render: { kind: "none" },
    });
    const runtime = createRuntime(paths, [convention], { areas: [area] });
    const coverage = runtime.context.coverageForFile("src/billing.ts");

    assert.equal(coverage.governed, true);
    assert.deepEqual(coverage.definitions.map((definition) => definition.id), ["billing-context", "billing-convention"]);
    assert.deepEqual(coverage.conventions.map((item) => item.id), ["billing-convention"]);
    assert.deepEqual(coverage.surfaces.map((surface) => surface.id), ["billing-surface"]);
    assert.deepEqual(coverage.checks.sort(), ["billing-convention", "billing-test", "tests/billing.test.ts"]);
    assert.deepEqual(runtime.context.filesForDefinition("area", "billing-context"), ["src/billing.ts"]);
    assert.deepEqual(runtime.context.checksForDefinition("area", "billing-context"), ["billing-test"]);
    assert.deepEqual(runtime.context.filesForSurface("billing-surface"), ["src/billing.ts"]);
    assert.deepEqual(runtime.context.definitionsForSurface("billing-surface").map((definition) => definition.id), ["billing-context", "billing-convention"]);
    assert.deepEqual(runtime.context.conventionsForSurface("billing-surface").map((item) => item.id), ["billing-convention"]);
    assert.deepEqual(runtime.context.checksForSurface("billing-surface").sort(), ["billing-convention", "billing-test", "tests/billing.test.ts"]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("restricted symbol and external command validators are generic project checks", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-symbols-"));
  try {
    mkdirSync(path.join(rootDir, "apps/api/src"), { recursive: true });
    mkdirSync(path.join(rootDir, "packages/db/src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "root", type: "module", workspaces: ["apps/*", "packages/*"] }));
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "filesystem",
        projectFilePatterns: ["apps/**/*.ts", "packages/**/*.ts", "**/package.json"],
        ignore: ["node_modules/**", ".git/**"],
        externalTools: {
          "failing-smoke": [process.execPath, "-e", "console.error('external failed'); process.exit(2);"],
        },
      }),
    );
    writeFileSync(path.join(rootDir, "apps/api/package.json"), JSON.stringify({ name: "@demo/api", dependencies: { "@demo/db": "workspace:*" } }));
    writeFileSync(path.join(rootDir, "apps/api/src/route.ts"), "import { internalTable } from '@demo/db/schema';\nexport const route = internalTable;\n");
    writeFileSync(path.join(rootDir, "packages/db/package.json"), JSON.stringify({ name: "@demo/db" }));
    writeFileSync(path.join(rootDir, "packages/db/src/schema.ts"), "export const internalTable = 'internal';\n");

    const resolved = resolveTestValidators([
      restrictedSymbols({
        id: "db-symbol-boundary",
        topics: ["boundaries"],
        severity: "error",
        in: ["apps/**/*.ts"],
        symbols: ["internalTable"],
        from: ["@demo/db"],
        allowIn: ["packages/db/**"],
        message: "DB schema internals are not allowed here.",
      }),
      externalCommand({
        id: "external-smoke",
        topics: ["doctor"],
        severity: "warning",
        command: "failing-smoke",
        timeoutMs: 1000,
        maxBufferBytes: 1024 * 1024,
        message: "External project check failed.",
      }),
    ]);
    assert.deepEqual(resolved.diagnostics, []);

    const findings = [];
    for (const validator of resolved.validators) {
      const ctx = createValidationContext({
        rootDir,
        paths: createPaths(rootDir),
        targetFiles: ["apps/api/src/route.ts"],
        analysisFiles: ["apps/api/src/route.ts"],
        validator,
      });
      findings.push(...(await validator.validate({ ctx, runtime: createRuntime(createPaths(rootDir), []) })));
    }

    assert.deepEqual(
      findings.map((finding) => [finding.validatorId, finding.severity, finding.file]),
      [
        ["db-symbol-boundary", "error", "apps/api/src/route.ts"],
        ["external-smoke", "warning", "<external-command>"],
      ],
    );
    assert(findings[0].message.includes("internalTable"));
    assert(findings[1].message.includes("external failed"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("external command validators have bounded execution", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-external-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    const validator = resolveTestValidators(
      externalCommand({
        id: "external-timeout",
        topics: ["doctor"],
        severity: "warning",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000);"],
        timeoutMs: 10,
        maxBufferBytes: 1024,
        message: "External project check timed out.",
      }),
    ).validators[0];
    const ctx = createValidationContext({
      rootDir,
      files: ["package.json"],
      targetFiles: ["package.json"],
      validator,
    });

    const findings = await validator.validate({ ctx, runtime: createRuntime(createPaths(rootDir), []) });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].validatorId, "external-timeout");
    assert(findings[0].message.includes("External project check timed out."));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("external command validators reject cwd outside project root", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-external-cwd-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    const validator = resolveTestValidators(
      externalCommand({
        id: "external-cwd",
        topics: ["doctor"],
        severity: "warning",
        command: process.execPath,
        args: ["--version"],
        cwd: "../outside",
        message: "External project check could not run.",
      }),
    ).validators[0];
    const ctx = createValidationContext({
      rootDir,
      files: ["package.json"],
      targetFiles: ["package.json"],
      validator,
    });

    const findings = await validator.validate({ ctx, runtime: createRuntime(createPaths(rootDir), []) });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].validatorId, "external-cwd");
    assert(findings[0].message.includes("External tool cwd is unsafe"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("external diagnostics resolve declared tools and file tokens", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-external-diagnostics-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    mkdirSync(path.join(rootDir, "tools"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(rootDir, "src/b.ts"), "export const b = 2;\n");
    writeFileSync(
      path.join(rootDir, "tools/demo-lint.ts"),
      [
        "const args = process.argv.slice(2);",
        "if (args.includes('--version')) { console.log('demo-lint 1.0.0'); process.exit(0); }",
        "if (!args.includes('opencanon.config.json')) { console.error('missing config'); process.exit(3); }",
        "const files = args.filter((arg) => arg.endsWith('.ts'));",
        "console.log(JSON.stringify(files.map((file) => ({ file, line: 1, column: 1, code: 'demo', message: `flagged ${file}` }))));",
      ].join("\n"),
    );
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "filesystem",
        projectFilePatterns: ["src/**/*.ts"],
        ignore: [],
        externalTools: {
          "demo-lint": {
            command: [process.execPath, "tools/demo-lint.ts"],
            versionArgs: ["--version"],
            missingSeverity: "error",
          },
        },
      }),
    );

    const paths = createPaths(rootDir);
    const validator = resolveTestValidators(
      externalDiagnostics({
        id: "demo-lint",
        topics: ["external"],
        severity: "error",
        command: "demo-lint",
        args: ["--config", "{config}", "{files}"],
        format: "json",
        message: "External lint failed.",
      }),
    ).validators[0];
    const ctx = createValidationContext({
      rootDir,
      paths,
      targetFiles: ["src/a.ts", "src/b.ts"],
      analysisFiles: ["src/a.ts", "src/b.ts"],
      validator,
    });

    const findings = await validator.validate({ ctx, runtime: createRuntime(paths, []) });

    assert.deepEqual(
      findings.map((finding) => [finding.file, finding.line, finding.column, finding.message]),
      [
        ["src/a.ts", 1, 1, "External lint failed. demo: flagged src/a.ts"],
        ["src/b.ts", 1, 1, "External lint failed. demo: flagged src/b.ts"],
      ],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doctor checks configured external tools with severity", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-doctor-tools-"));
  try {
    mkdirSync(path.join(rootDir, "tools"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "tools/demo-lint.ts"),
      "if (process.argv.includes('--version')) { console.log('demo-lint 1.0.0'); process.exit(0); }\n",
    );
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "filesystem",
        projectFilePatterns: ["tools/**/*.ts"],
        ignore: [],
        externalTools: {
          "demo-lint": {
            command: [process.execPath, "tools/demo-lint.ts"],
            versionArgs: ["--version"],
          },
          "optional-missing": {
            command: "opencanon-missing-optional-tool",
            missingSeverity: "warning",
          },
          "required-missing": {
            command: "opencanon-missing-required-tool",
            missingSeverity: "error",
          },
        },
      }),
    );

    const paths = createPaths(rootDir);
    const skippedReport = buildDoctorReport({ paths, conventions: [], validators: [] });
    const skippedCheck = skippedReport.checks.find((item) => item.id === "external-tools");

    assert.equal(skippedCheck?.status, "warn");
    assert(skippedCheck?.message.includes("not executed"));

    const report = buildDoctorReport({ paths, conventions: [], validators: [], runExternalTools: true });
    const check = report.checks.find((item) => item.id === "external-tools");

    assert.equal(check?.status, "fail");
    assert(check?.details?.some((detail) => detail.includes("demo-lint 1.0.0")));
    assert(check?.details?.some((detail) => detail.includes("optional-missing: missing command opencanon-missing-optional-tool")));
    assert(check?.details?.some((detail) => detail.includes("required-missing: missing command opencanon-missing-required-tool")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doctor reports invalid project discovery config", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-doctor-"));
  try {
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "unknown",
        maxFiles: -1,
        maxFileSizeKb: -1,
      }),
    );

    const paths = createPaths(rootDir);
    const report = buildDoctorReport({ paths, conventions: [], validators: [] });
    const check = report.checks.find((item) => item.id === "project-discovery");

    assert.equal(check?.status, "fail");
    assert(check?.details?.some((detail) => detail.includes("fileDiscovery")));
    assert(check?.details?.some((detail) => detail.includes("maxFiles")));
    assert(check?.details?.some((detail) => detail.includes("maxFileSizeKb")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doctor uses the authoritative producer statuses when provided (live producer beats absent sidecar)", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-doctor-producers-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), "{\"type\":\"module\",\"scripts\":{\"opencanon\":\"opencanon\"}}\n");
    const paths = createPaths(rootDir);

    // No sidecar on disk. Headless resolve would report typescript "stale".
    // But when the running runtime's authoritative status (live producer ready)
    // is passed in, doctor must report it ready — not inspect the sidecar fs.
    const report = buildDoctorReport({
      paths,
      conventions: [],
      validators: [],
      producerStatuses: [{ language: "typescript", kind: "ready", generation: 3 }],
    });
    const check = report.checks.find((item) => item.id === "type-producers");
    assert.equal(check?.status, "pass");
    assert(check?.details?.some((line) => line.includes("typescript: ready")));
    assert(!check?.details?.some((line) => line.includes("analyze --typed")), "no stale/run-analyze hint when live is ready");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doctor treats TypeScript producer as not applicable for JavaScript-only projects", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-doctor-js-producer-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    mkdirSync(path.join(rootDir, "opencanon/conventions"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), "{\"type\":\"module\",\"scripts\":{\"opencanon\":\"opencanon\"}}\n");
    writeFileSync(path.join(rootDir, "src/index.js"), "export const ok = true;\n");
    writeFileSync(path.join(rootDir, "opencanon/conventions/index.ts"), "export default [];\n");
    writeFileSync(path.join(rootDir, "opencanon/tsconfig.json"), "{\"compilerOptions\":{\"noEmit\":true}}\n");

    const report = buildDoctorReport({ paths: createPaths(rootDir), conventions: [], validators: [] });
    const check = report.checks.find((item) => item.id === "type-producers");
    assert.equal(check?.status, "pass");
    assert(check?.details?.some((line) => line.includes("typescript: not-implemented")));
    assert(check?.details?.some((line) => line.includes("No root tsconfig.json or user TypeScript source files")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doctor treats missing config as built-in defaults", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-doctor-defaults-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), "{\"type\":\"module\",\"scripts\":{\"opencanon\":\"opencanon\"}}\n");

    const report = buildDoctorReport({ paths: createPaths(rootDir), conventions: [], validators: [] });
    const check = report.checks.find((item) => item.id === "config");

    assert.equal(check?.status, "pass");
    assert(check?.message.includes("built-in defaults"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doctor fails registered unhealthy runtime state", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-doctor-runtime-health-"));
  try {
    const report = buildDoctorReport({
      paths: createPaths(rootDir),
      conventions: [],
      validators: [],
      runtimeHealth: {
        service: { status: "running", registered: true, message: "OpenCanon service health endpoint is ready." },
        project: { status: "stale", registered: true, lifecycleStatus: "backing-off", message: "Registered process is not running." },
      },
    });
    const check = report.checks.find((item) => item.id === "runtime-health");

    assert.equal(report.status, DoctorStatus.Fail);
    assert.equal(check?.status, DoctorStatus.Fail);
    assert(check?.details?.some((detail) => detail.includes("Project runtime is stale")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doctor reports and fixes unignored cache files", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-cache-ignore-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), "{\"type\":\"module\",\"scripts\":{\"opencanon\":\"opencanon\"}}\n");
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "git" }));
    spawnSync("git", ["init"], { cwd: rootDir, stdio: "ignore" });

    const paths = createPaths(rootDir);
    const report = buildDoctorReport({ paths, conventions: [], validators: [] });
    const check = report.checks.find((item) => item.id === "cache-ignore");
    const generatedCheck = report.checks.find((item) => item.id === "generated-ignore");

    assert.equal(check?.status, "fail");
    assert(check?.details?.some((detail) => detail.includes(".opencanon/cache/")));
    assert.equal(generatedCheck?.status, "fail");
    assert(generatedCheck?.details?.some((detail) => detail.includes(".opencanon/generated/")));

    const fix = applyDoctorFixes({ paths, report, mode: "safe", dryRun: false });
    assert.equal(fix.diagnostics.length, 0);
    const gitignore = readFileSync(path.join(rootDir, ".gitignore"), "utf8");
    assert(gitignore.includes(".opencanon/cache/"));
    assert(gitignore.includes(".opencanon/generated/"));
    assert(gitignore.includes(".opencanon/worker.lock"));
    assert(gitignore.includes(".opencanon/*.sqlite"));
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/.gitignore")), false);

    const fixedReport = buildDoctorReport({ paths, conventions: [], validators: [] });
    assert.equal(fixedReport.checks.find((item) => item.id === "cache-ignore")?.status, "pass");
    assert.equal(fixedReport.checks.find((item) => item.id === "generated-ignore")?.status, "pass");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doctor reports and fixes stale generated project authoring support", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-project-authoring-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), "{\"name\":\"demo\",\"type\":\"module\",\"scripts\":{\"opencanon\":\"opencanon\"}}\n");
    const paths = createPaths(rootDir);
    generateProjectTypes(rootDir, paths);
    const generatedPath = path.join(rootDir, ProjectTypesFilePath);
    writeFileSync(generatedPath, "// stale generated authoring support\n");

    const report = buildDoctorReport({ paths, conventions: [], validators: [] });
    const check = report.checks.find((item) => item.id === "project-authoring");
    assert.equal(check?.status, "fail");
    assert(check?.details?.some((detail) => detail.includes("drifted")));

    const fix = applyDoctorFixes({ paths, report, mode: FixModeValue.Safe, dryRun: false });
    assert.equal(fix.diagnostics.length, 0);
    assert.equal(fix.skipped.length, 0);

    const fixedSource = readFileSync(generatedPath, "utf8");
    assert(fixedSource.includes("Generated by OpenCanon"));
    assert(fixedSource.includes("export const Packages"));
    const fixedReport = buildDoctorReport({ paths, conventions: [], validators: [] });
    assert.equal(fixedReport.checks.find((item) => item.id === "project-authoring")?.status, "pass");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doctor reports and fixes managed agent entry blocks", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-agent-entry-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), "{\"name\":\"demo\",\"type\":\"module\",\"scripts\":{\"opencanon\":\"opencanon\"}}\n");
    writeFileSync(path.join(rootDir, "AGENTS.md"), "# Team Rules\n\nKeep this note.\n\n<opencanon>\nstale\n</opencanon>\n");
    const paths = createPaths(rootDir);

    const report = buildDoctorReport({ paths, conventions: [], validators: [] });
    const check = report.checks.find((item) => item.id === "agent-entry");
    assert.equal(check?.status, "fail");
    assert(check?.details?.some((detail) => detail.includes("AGENTS.md managed")));
    assert(check?.details?.some((detail) => detail.includes("CLAUDE.md is missing")));

    const fix = applyDoctorFixes({ paths, report, mode: FixModeValue.Safe, dryRun: false });
    assert.equal(fix.diagnostics.length, 0);
    assert.equal(fix.skipped.length, 0);

    const agents = readFileSync(path.join(rootDir, "AGENTS.md"), "utf8");
    assert(agents.includes("Keep this note."));
    assert(agents.includes(renderOpenCanonAgentEntryBlock()));
    assert(readFileSync(path.join(rootDir, "CLAUDE.md"), "utf8").includes(renderOpenCanonAgentEntryBlock()));
    const fixedReport = buildDoctorReport({ paths, conventions: [], validators: [] });
    assert.equal(fixedReport.checks.find((item) => item.id === "agent-entry")?.status, "pass");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doctor reports and fixes managed OpenCanon skill files", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-skill-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), "{\"name\":\"demo\",\"type\":\"module\",\"scripts\":{\"opencanon\":\"bun .agents/skills/opencanon/scripts/opencanon.ts\"}}\n");
    const skillPath = path.join(rootDir, OpenCanonSkillFilePath);
    mkdirSync(path.dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "# OpenCanon\n\nstale\n");
    const retiredRuntimePath = path.join(rootDir, ".agents/skills/opencanon/runtime/cli.js");
    const retiredLauncherPath = path.join(rootDir, ".agents/skills/opencanon/scripts/opencanon.ts");
    mkdirSync(path.dirname(retiredRuntimePath), { recursive: true });
    mkdirSync(path.dirname(retiredLauncherPath), { recursive: true });
    writeFileSync(retiredRuntimePath, "old runtime");
    writeFileSync(retiredLauncherPath, "old launcher");
    const paths = createPaths(rootDir);

    const report = buildDoctorReport({ paths, conventions: [], validators: [] });
    const check = report.checks.find((item) => item.id === "opencanon-skill");
    assert.equal(check?.status, "fail");
    assert(check?.details?.some((detail) => detail.includes("OpenCanon skill file drifted")));
    assert(check?.details?.some((detail) => detail.includes("references/implementation.md")));
    assert(check?.details?.some((detail) => detail.includes("Retired OpenCanon skill artifact remains")));
    const packageScriptsCheck = report.checks.find((item) => item.id === "package-scripts");
    assert.equal(packageScriptsCheck?.status, "fail");
    assert(packageScriptsCheck?.details?.some((detail) => detail.includes("scripts.opencanon should be")));

    const fix = applyDoctorFixes({ paths, report, mode: FixModeValue.Safe, dryRun: false });
    assert.equal(fix.diagnostics.length, 0);
    assert.equal(fix.skipped.length, 0);

    const fixedSkill = readFileSync(skillPath, "utf8");
    assert(fixedSkill.includes("Progressive References"));
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/references/implementation.md"), "utf8").includes("Implementation Workflow"));
    assert.notEqual(statSync(path.join(rootDir, ".agents/skills/opencanon/scripts/opencanon-brief-context.sh")).mode & 0o111, 0);
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/runtime")), false);
    assert.equal(existsSync(retiredLauncherPath), false);
    assert.equal(JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).scripts.opencanon, "opencanon");
    const fixedReport = buildDoctorReport({ paths, conventions: [], validators: [] });
    assert.equal(fixedReport.checks.find((item) => item.id === "opencanon-skill")?.status, "pass");
    assert.equal(fixedReport.checks.find((item) => item.id === "package-scripts")?.status, "pass");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("context command lists convention exceptions", () => {
  const result = spawnSync(process.execPath, ["packages/cli/src/index.ts", "context", "--list-exceptions", "--format", "json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { exceptions: [] });
});

test("fixture checks can be scoped to one validator", () => {
  const result = spawnSync(process.execPath, ["packages/cli/src/index.ts", "validate", "--check-fixtures", "--validator", "no-native-enums"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert(result.stdout.includes("no-native-enums/valid"));
  assert(result.stdout.includes("no-native-enums/invalid"));
  assert(!result.stdout.includes("dal-transaction-param/valid"));
});

test("fixture checks fail when required flat fixture files are missing", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-missing-fixtures-"));
  try {
    mkdirSync(path.join(rootDir, "docs/opencanon"), { recursive: true });
    mkdirSync(path.join(rootDir, "conventions"), { recursive: true });
    mkdirSync(path.join(rootDir, "fixtures/missing-invalid"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "filesystem",
        conventionsPath: "conventions/index.ts",
        fixturesDir: "fixtures",
        projectFilePatterns: ["src/**/*.ts"],
        ignore: ["node_modules/**", ".git/**"],
        requiredPackageScripts: [],
      }),
    );
    writeFileSync(
      path.join(rootDir, "conventions/index.ts"),
      `import { defineConvention } from "@opencanon/core";

export default defineConvention({
  id: "missing-invalid",
  title: "Missing invalid",
  topics: ["test"],
  rule: "Missing invalid.",
  applies: { kind: "files", globs: ["src/**/*.ts"] },
  render: { kind: "none" },
  runtime: {
    kind: "validator",
    severity: "error",
    scope: "file",
    facts: [],
    validate() {
      return [];
    },
  },
});
`,
    );
    writeFileSync(
      path.join(rootDir, "fixtures/missing-invalid/valid.ts"),
      ['import { defineFixture } from "@opencanon/core/testing";', "", "export default defineFixture({});", ""].join("\n"),
    );

    const script = path.join(process.cwd(), "packages/cli/src/index.ts");
    const result = spawnSync(process.execPath, [script, "validate", "--check-fixtures"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert(result.stdout.includes("Missing required fixture file: fixtures/missing-invalid/invalid.ts"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rules command renders validator summaries and fixture coverage", () => {
  const result = spawnSync(process.execPath, ["packages/cli/src/index.ts", "rules", "--validator", "no-native-enums"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert(result.stdout.includes("# OpenCanon Rules"));
  assert(result.stdout.includes("## no-native-enums [error]"));
  assert(result.stdout.includes("Summary: Files matching"));
  assert(result.stdout.includes("Fixtures: valid, invalid, fixed"));
  assert(!result.stdout.includes("## dal-transaction-param"));
});

test("rules command filters validators by linked convention", () => {
  const result = spawnSync(process.execPath, ["packages/cli/src/index.ts", "rules", "--convention", "const-object-enums"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert(result.stdout.includes("## no-native-enums [error]"));
  assert(result.stdout.includes("## repeated-domain-literals [warning]"));
  assert(!result.stdout.includes("## service-no-db-client"));
});

test("rules command renders tree visualizations", () => {
  const result = spawnSync(process.execPath, ["packages/cli/src/index.ts", "rules", "--tree", "--validator", "no-dumpster-folders", "--ascii", "--no-color"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert(result.stdout.includes("# OpenCanon Rule Trees"));
  assert(result.stdout.includes("### Folder Names"));
  assert(result.stdout.includes("|-- src"));
  assert(result.stdout.includes("folders.denyNames: misc, helpers, common, temp, new, draft"));
});

test("rules command renders boundary visualizations as edge trees", () => {
  const result = spawnSync(process.execPath, ["packages/cli/src/index.ts", "rules", "--tree", "--validator", "service-no-db-client", "--ascii", "--no-color"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert(result.stdout.includes("`-- from"));
  assert(result.stdout.includes("|-- deny -> denied"));
  assert(result.stdout.includes("|   |-- src/db/client.ts"));
  assert(!result.stdout.includes("undefined"));
});

test("validate strict-warnings controls warning exit status", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-strict-warnings-"));
  try {
    mkdirSync(path.join(rootDir, "docs/opencanon"), { recursive: true });
    mkdirSync(path.join(rootDir, "conventions"), { recursive: true });
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "filesystem",
        conventionsPath: "conventions/index.ts",
        fixturesDir: "fixtures",
        projectFilePatterns: ["src/**/*.ts"],
        ignore: ["node_modules/**", ".git/**"],
        requiredPackageScripts: [],
      }),
    );
    writeFileSync(path.join(rootDir, "src/a.ts"), "const value = 'warn';\n");
    writeFileSync(
      path.join(rootDir, "conventions/index.ts"),
      `import { defineConvention } from "@opencanon/core";

export default defineConvention({
  id: "warning-rule",
  title: "Warning rule",
  topics: ["test"],
  rule: "Warning rule.",
  applies: { kind: "files", globs: ["src/**/*.ts"] },
  render: { kind: "none" },
  runtime: {
    kind: "validator",
    severity: "warning",
    scope: "file",
    facts: [],
    validate({ ctx }) {
      return ctx.targetFiles.flatMap((file) =>
        file.find("warn").map((match) =>
          file.report({
            line: match.line,
            column: match.column,
            message: "Warning finding.",
          }),
        ),
      );
    },
  },
});
`,
    );

    const script = path.join(process.cwd(), "packages/cli/src/index.ts");
    const env = isolatedCliEnv(rootDir);
    const normal = spawnSync(process.execPath, [script, "validate", "--files", "src/a.ts"], {
      cwd: rootDir,
      encoding: "utf8",
      env,
    });
    assert.equal(normal.status, 0, normal.stderr || normal.stdout);
    assert(normal.stdout.includes("Finding Resolution Policy"));
    assert(normal.stdout.includes("warning: non-blocking finding"));

    const strict = spawnSync(process.execPath, [script, "validate", "--files", "src/a.ts", "--strict-warnings"], {
      cwd: rootDir,
      encoding: "utf8",
      env,
    });
    assert.equal(strict.status, 1, strict.stderr || strict.stdout);
  } finally {
    stopIsolatedCliRuntime(rootDir);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("validate --files ignores absolute paths outside the current OpenCanon project", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-validate-external-root-"));
  const outsideDir = mkdtempSync(path.join(tmpdir(), "opencanon-validate-external-file-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(outsideDir, "external.ts"), "export const external = true;\n");
    const script = path.join(process.cwd(), "packages/cli/src/index.ts");

    const result = spawnSync(process.execPath, [script, "validate", "--files", path.join(outsideDir, "external.ts"), "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as { files: string[]; findings: Array<{ validatorId: string }> };
    assert.deepEqual(payload.files, []);
    assert.deepEqual(payload.findings, []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("validator graph resolves OpenCanon package-prefixed authoring imports", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-authoring-imports-"));
  try {
    mkdirSync(path.join(rootDir, "docs/opencanon"), { recursive: true });
    mkdirSync(path.join(rootDir, "conventions"), { recursive: true });
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "filesystem",
        conventionsPath: "conventions/index.ts",
        fixturesDir: "fixtures",
        projectFilePatterns: ["src/**/*.ts"],
        ignore: ["node_modules/**", ".git/**"],
        requiredPackageScripts: [],
      }),
    );
    writeFileSync(path.join(rootDir, "src/a.ts"), "const value = 'warn';\n");
    writeFileSync(
      path.join(rootDir, "conventions/index.ts"),
      `import { defineConvention } from "@opencanon/core";
import { Packages } from "@opencanon/project";

export default defineConvention({
  id: "package-import-rule",
  title: "Package import rule",
  topics: ["test"],
  rule: "Package import rule.",
  applies: { kind: "files", globs: ["src/**/*.ts"] },
  render: { kind: "none" },
  runtime: {
    kind: "validator",
    severity: "warning",
    scope: "file",
    facts: [],
    validate({ ctx }) {
      return ctx.targetFiles.flatMap((file) =>
        file.find("warn").map((match) =>
          file.report({
            line: match.line,
            column: match.column,
            message: \`Package import finding from \${Packages.ROOT}.\`,
          }),
        ),
      );
    },
  },
});
`,
    );

    const script = path.join(process.cwd(), "packages/cli/src/index.ts");
    const env = isolatedCliEnv(rootDir);
    const setup = spawnSync(process.execPath, [script, "init", "--yes", "--no-runtime"], {
      cwd: rootDir,
      encoding: "utf8",
      env,
    });
    assert.equal(setup.status, 0, setup.stderr || setup.stdout);
    assert.equal(existsSync(path.join(rootDir, ".opencanon/generated/authoring/project.ts")), true);

    const result = spawnSync(process.execPath, [script, "validate", "--files", "src/a.ts"], {
      cwd: rootDir,
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert(result.stdout.includes("Package import finding from <root>."));
  } finally {
    stopIsolatedCliRuntime(rootDir);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project context skips broken symlinks in ignored directories", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-project-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    mkdirSync(path.join(rootDir, "node_modules/.bin"), { recursive: true });
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem" }));
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = {};\n");
    symlinkSync("missing-target", path.join(rootDir, "node_modules/.bin/missing-command"));

    const ctx = createValidationContext({
      rootDir,
      paths: createPaths(rootDir),
      validator: { id: "sample-validator", severity: "error" },
    });

    assert.deepEqual(
      ctx.files.map((file) => file.path),
      ["src/company.ts"],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function initGitRepo(rootDir: string): void {
  for (const args of [
    ["init"],
    ["config", "user.email", "opencanon@example.com"],
    ["config", "user.name", "OpenCanon Test"],
    ["add", "."],
    ["commit", "-m", "initial"],
  ]) {
    const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
}

function git(rootDir: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("literal facts carry declarationSourceId for const-object and type-union shapes", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-decl-source-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "src/status.ts"),
      [
        "export const CompanyStatus = {",
        "  ACTIVE: \"active\",",
        "  INACTIVE: \"inactive\",",
        "} as const;",
        "export type Mode = \"on\" | \"off\";",
        "export function pick(value: string) {",
        "  return value === \"active\" ? CompanyStatus.ACTIVE : CompanyStatus.INACTIVE;",
        "}",
      ].join("\n"),
    );

    const validator = resolveTestValidators(
      testValidatorDefinition({
        id: "decl-source-id-probe",
        topics: ["typed-literals"],
        severity: "warning",
        scope: "file",
        facts: ["literals"],
        applies: ["src/**/*.ts"],
        validate: () => [],
      }),
    ).validators[0];
    const ctx = createValidationContext({
      rootDir,
      files: ["src/status.ts"],
      targetFiles: ["src/status.ts"],
      analysisFiles: ["src/status.ts"],
      validator,
    });

    const declared = ctx.facts.literals().filter((literal) => literal.declarationSourceId);
    const byName = new Map<string, Set<string>>();
    for (const literal of declared) {
      const set = byName.get(literal.declarationSourceId!) ?? new Set<string>();
      set.add(literal.value);
      byName.set(literal.declarationSourceId!, set);
    }
    assert.deepEqual([...(byName.get("CompanyStatus") ?? [])].sort(), ["active", "inactive"]);
    assert.deepEqual([...(byName.get("Mode") ?? [])].sort(), ["off", "on"]);

    // Comparison literals outside the declaration must not be tagged.
    const comparison = ctx.facts.literals().find((literal) => literal.context === LiteralContext.Comparison && literal.value === "active");
    assert(comparison);
    assert.equal(comparison?.declarationSourceId, undefined);

    // ctx.typed.literal narrows by declarationSourceId and resolves via the Tier 1 analyzer.
    const matches = ctx.typed.literal({ declarationSourceId: "CompanyStatus", valueKind: "string" });
    assert.equal(matches.length, 2);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("SidecarTypeFactsProvider serves finite-set hits only when ready; non-finite is absent", async () => {
  const { SidecarTypeFactsProvider, siteKey } = await import("@opencanon/core");
  const payload = {
    version: 1 as const,
    generatedAt: "x",
    tsconfigPath: "tsconfig.json",
    tsconfigHash: "h",
    tsVersion: "5.9.0",
    gitHead: "",
    sourceFiles: [],
    membershipHash: "m",
    coverage: { programFiles: 1, comparisonSites: 1, checkedSites: 1 },
    entries: [
      {
        file: "src/x.ts",
        line: 10,
        column: 5,
        display: "Status",
        symbolId: "Status",
        typeSource: "declared" as const,
        kind: "literal-union" as const,
        members: [
          { value: { kind: "string" as const, value: "on" }, display: '"on"' },
          { value: { kind: "string" as const, value: "off" }, display: '"off"' },
        ],
        syntax: "ts-union" as const,
      },
      // A non-finite ("other") site recorded internally — must NEVER surface.
      { file: "src/x.ts", line: 2, column: 1, display: "Mode", symbolId: "Mode", typeSource: "declared" as const, kind: "other" as const },
    ],
  };
  const ready = new SidecarTypeFactsProvider(payload, { language: "typescript", kind: "ready" });
  assert.equal(ready.status().kind, "ready");
  const map = await ready.resolveTypes([
    { file: "src/x.ts", line: 10, column: 5 },
    { file: "src/x.ts", line: 2, column: 1 },
  ]);
  // Finite-set hit reconstructed as a literal-union (no confidence field).
  assert.deepEqual(map.get(siteKey("src/x.ts", 10, 5)), {
    kind: "literal-union",
    language: "typescript",
    display: "Status",
    symbolId: "Status",
    typeSource: "declared",
    members: [
      { value: { kind: "string", value: "on" }, display: '"on"' },
      { value: { kind: "string", value: "off" }, display: '"off"' },
    ],
    syntax: "ts-union",
  });
  // Non-finite ("other") site never surfaces.
  assert.equal(map.has(siteKey("src/x.ts", 2, 1)), false);

  // A stale producer serves NOTHING, even for finite-set entries (binary).
  const stale = new SidecarTypeFactsProvider(payload, { language: "typescript", kind: "stale", detail: "source-drift" });
  const staleMap = await stale.resolveTypes([{ file: "src/x.ts", line: 10, column: 5 }]);
  assert.equal(staleMap.size, 0);
});

test("asFiniteLiteralSet / finiteLiteralIncludes capability accessors", async () => {
  const { asFiniteLiteralSet, finiteLiteralIncludes } = await import("@opencanon/core");
  const union = {
    kind: "literal-union" as const,
    language: "typescript",
    display: "Status",
    typeSource: "declared" as const,
    syntax: "ts-union" as const,
    members: [
      { value: { kind: "string" as const, value: "on" }, display: '"on"' },
      { value: { kind: "string" as const, value: "off" }, display: '"off"' },
    ],
  };

  const set = asFiniteLiteralSet(union);
  assert.ok(set);
  assert.deepEqual(set!.members.map((m) => m.value && m.value.kind === LiteralValueKind.String ? m.value.value : undefined), ["on", "off"]);
  assert.equal(asFiniteLiteralSet(undefined), undefined);

  assert.equal(finiteLiteralIncludes(union, "on"), true);
  assert.equal(finiteLiteralIncludes(union, "nope"), false);
  assert.equal(finiteLiteralIncludes(undefined, "on"), false);
});

test("ctx.typed.literal returns surroundingType only when the producer is ready", async () => {
  const { prewarmTypeFacts, createValidationContextFromFixture, flushValidationContextCache, siteKey } =
    await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-prewarm-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const srcText = "export function f(value: Mode) {\n  return value === \"on\";\n}\n";
    writeFileSync(path.join(rootDir, "src", "x.ts"), srcText);
    const ctx = createValidationContextFromFixture({ rootDir, validator: { id: "t", severity: "warning" } });
    const literals = ctx.facts.literals().filter((l) => l.context === LiteralContext.Comparison && l.value === "on");
    assert.equal(literals.length, 1);
    const site = literals[0];
    const resolution = {
      kind: "literal-union" as const,
      language: "typescript",
      display: "Mode",
      symbolId: "Mode",
      typeSource: "declared" as const,
      members: [{ value: { kind: "string" as const, value: "on" }, display: '"on"' }],
      syntax: "ts-union" as const,
    };

    // 1. A non-ready (stale) producer resolves nothing → no surroundingType.
    const staleProvider = {
      language: "typescript",
      status() {
        return { language: "typescript", kind: "stale" as const, detail: "source-drift" };
      },
      factGeneration() {
        return undefined;
      },
      async resolveTypes() {
        return new Map();
      },
    };
    await prewarmTypeFacts(ctx, staleProvider);
    assert.equal(ctx.typed.literal({ surroundingTypeName: "Mode" }).length, 0);
    assert.equal(ctx.typed.producerStatus("typescript").kind, "stale");

    // 2. A ready producer covering the site → surroundingType present.
    const readyProvider = {
      language: "typescript",
      status() {
        return { language: "typescript", kind: "ready" as const };
      },
      factGeneration() {
        return undefined;
      },
      async resolveTypes(sites: { file: string; line: number; column: number }[]) {
        const map = new Map();
        for (const s of sites) map.set(siteKey(s.file, s.line, s.column), resolution);
        return map;
      },
    };
    await prewarmTypeFacts(ctx, readyProvider);
    const hit = ctx.typed.literal({ surroundingTypeName: "Mode" });
    assert.equal(hit.length, 1);
    assert.equal(hit[0].surroundingType?.display, "Mode");
    assert.equal(ctx.typed.producerStatus("typescript").kind, "ready");
    void site;
    flushValidationContextCache(ctx);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resolveProducerStatuses reports ready / stale / disabled / not-implemented", async () => {
  const { resolveProducerStatuses, membershipHashOf, listMembershipFiles, ProducerStatusKind } = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-producer-status-"));
  try {
    linkWorkspaceTypeScript(rootDir);
    // No tsconfig + project-local TypeScript present → missing-tsconfig.
    const initial = resolveProducerStatuses(rootDir);
    assert.equal(initial.length, 1);
    assert.equal(initial[0].language, "typescript");
    assert.equal(initial[0].kind, ProducerStatusKind.MissingTsconfig);

    // Add tsconfig + a fresh sidecar → ready.
    const tsconfig = JSON.stringify({ compilerOptions: { noEmit: true, skipLibCheck: true }, include: ["src/**/*"] });
    writeFileSync(path.join(rootDir, "tsconfig.json"), tsconfig);
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const srcPath = path.join(rootDir, "src", "x.ts");
    const srcText = "export type Status = 'on' | 'off';\n";
    writeFileSync(srcPath, srcText);
    const srcStat = statSync(srcPath);
    mkdirSync(path.join(rootDir, ".opencanon", "cache"), { recursive: true });
    const sidecarPath = path.join(rootDir, ".opencanon", "cache", "typed-comparisons.json");
    writeFileSync(sidecarPath, JSON.stringify({
      version: 1,
      generatedAt: "x",
      tsconfigPath: "tsconfig.json",
      tsconfigHash: createHashHex(tsconfig),
      tsVersion: "",
      gitHead: "",
      sourceFiles: [{ path: "src/x.ts", sha256: createHashHex(srcText), mtimeMs: srcStat.mtimeMs, size: srcStat.size }],
      membershipHash: membershipHashOf(listMembershipFiles(rootDir)),
      coverage: { programFiles: 1, comparisonSites: 1, checkedSites: 1 },
      entries: [],
    }));
    assert.equal(resolveProducerStatuses(rootDir)[0].kind, "ready");

    // Editing the source invalidates the sidecar → stale.
    writeFileSync(srcPath, "export type Status = 'on' | 'off' | 'pending';\n");
    assert.equal(resolveProducerStatuses(rootDir)[0].kind, "stale");

    // Env opt-out → disabled (folds OPENCANON_TYPED_PRODUCER into status).
    const prev = process.env.OPENCANON_TYPED_PRODUCER;
    process.env.OPENCANON_TYPED_PRODUCER = "off";
    try {
      assert.equal(resolveProducerStatuses(rootDir)[0].kind, "disabled");
    } finally {
      if (prev === undefined) delete process.env.OPENCANON_TYPED_PRODUCER;
      else process.env.OPENCANON_TYPED_PRODUCER = prev;
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resolveProducerStatuses reports unsupported project TypeScript versions explicitly", async () => {
  const { resolveProducerStatuses, ProducerStatusKind } = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-producer-status-unsupported-"));
  try {
    writeFileSync(path.join(rootDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true }, include: [] }));
    const packageRoot = path.join(rootDir, "node_modules/typescript");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "typescript", version: "4.9.5" }));

    const status = resolveProducerStatuses(rootDir)[0];
    assert.equal(status.kind, ProducerStatusKind.UnsupportedPackage);
    assert.match(status.detail ?? "", />=5\.0\.0 <7\.0\.0/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("producer registry owns semantic producer definitions and unknown languages are not implemented", async () => {
  const { ProducerArtifactId, ProducerLiveWorkerId, ProducerStatusKind, ProjectFileLanguage, producerDefinitionForLanguage, producerDefinitions, resolveAuthoritativeProducerStatus } = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-producer-registry-"));
  try {
    const definitions = producerDefinitions();
    assert.deepEqual(definitions.map((definition) => definition.language), [ProjectFileLanguage.TypeScript]);
    const typescriptDefinition = producerDefinitionForLanguage(ProjectFileLanguage.TypeScript);
    assert.equal(typescriptDefinition?.artifacts[ProducerArtifactId.TypedComparisons]?.id, ProducerArtifactId.TypedComparisons);
    assert.equal(typescriptDefinition?.liveWorkers[ProducerLiveWorkerId.TypeScriptWatch]?.id, ProducerLiveWorkerId.TypeScriptWatch);
    assert.equal(producerDefinitionForLanguage(ProjectFileLanguage.Python), undefined);

    const python = resolveAuthoritativeProducerStatus(rootDir, ProjectFileLanguage.Python).status;
    assert.equal(python.kind, ProducerStatusKind.NotImplemented);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project-local producer packages do not fall back to OpenCanon's own dependencies", async () => {
  const { ProducerStatusKind, listMembershipFiles, membershipHashOf, resolveProducerStatuses } = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-producer-local-package-"));
  try {
    const tsconfig = JSON.stringify({ compilerOptions: { noEmit: true }, include: [] });
    writeFileSync(path.join(rootDir, "tsconfig.json"), tsconfig);
    const status = resolveProducerStatuses(rootDir)[0];
    assert.equal(status.kind, ProducerStatusKind.MissingPackage);
    assert.match(status.detail ?? "", /project root/);

    mkdirSync(path.join(rootDir, ".opencanon", "cache"), { recursive: true });
    writeFileSync(path.join(rootDir, ".opencanon", "cache", "typed-comparisons.json"), JSON.stringify({
      version: 1,
      generatedAt: "x",
      tsconfigPath: "tsconfig.json",
      tsconfigHash: createHashHex(tsconfig),
      tsVersion: "",
      gitHead: "",
      sourceFiles: [],
      membershipHash: membershipHashOf(listMembershipFiles(rootDir)),
      coverage: { programFiles: 0, comparisonSites: 0, checkedSites: 0 },
      entries: [],
    }));
    assert.equal(resolveProducerStatuses(rootDir)[0].kind, ProducerStatusKind.MissingPackage);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("opencanon analyze --typed writes a sidecar with comparison-context entries", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-sidecar-"));
  try {
    const projectTsVersion = linkWorkspaceTypeScript(rootDir);
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler", noEmit: true, skipLibCheck: true },
      include: ["src/**/*"],
    }));
    writeFileSync(
      path.join(rootDir, "src/status.ts"),
      [
        "export type Status = \"on\" | \"off\";",
        "export function isOn(value: Status) {",
        "  return value === \"on\";",
        "}",
      ].join("\n"),
    );

    const analyzeUrl = new URL("../packages/cli/src/analyze.ts", import.meta.url).href;
    const { runAnalyzeCommand } = (await import(analyzeUrl)) as typeof import("../packages/cli/src/analyze.ts");
    await runAnalyzeCommand(["--typed"], rootDir);
    const sidecarPath = path.join(rootDir, ".opencanon", "cache", "typed-comparisons.json");
    assert(existsSync(sidecarPath), "sidecar should be written");
    const cli = path.resolve("packages/cli/src/index.ts");
    const jsonResult = spawnSync(process.execPath, [cli, "analyze", "--typed", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    const analyzeSummary = JSON.parse(jsonResult.stdout) as { outputPath: string; coverage: { comparisonSites: number; checkedSites: number; checkedRatio: number } };
    assert.equal(realpathSync(analyzeSummary.outputPath), realpathSync(sidecarPath));
    assert.equal(analyzeSummary.coverage.comparisonSites, 1);
    assert.equal(analyzeSummary.coverage.checkedSites, 1);
    assert.equal(analyzeSummary.coverage.checkedRatio, 100);
    const payload = JSON.parse(readFileSync(sidecarPath, "utf8"));
    assert.equal(payload.version, 1);
    assert(Array.isArray(payload.entries));
    assert(Array.isArray(payload.sourceFiles), "sidecar records source fingerprints");
    assert(payload.sourceFiles.length > 0);
    assert(payload.sourceFiles.every((sf: { sha256: string; size: number }) => sf.sha256.length === 64 && sf.size >= 0));
    assert.equal(payload.tsVersion, projectTsVersion);
    assert(payload.coverage && payload.coverage.programFiles >= 1, "sidecar records coverage");
    assert.equal(payload.coverage.comparisonSites, 1);
    assert.equal(payload.coverage.checkedSites, 1);
    assert(typeof payload.membershipHash === "string" && payload.membershipHash.length === 64, "sidecar records membershipHash");
    // `value: Status` where `Status = "on" | "off"` → literal-union with enumerated members.
    const onEntry = payload.entries.find((entry: { display: string }) => entry.display === "Status");
    assert(onEntry, `sidecar should contain Status entry, got: ${JSON.stringify(payload.entries)}`);
    assert.equal(onEntry.kind, "literal-union", "string-literal union resolves to literal-union");
    const memberValues = (onEntry.members ?? []).map((m: { value?: { kind: string; value?: string } }) => m.value?.value).sort();
    assert.deepEqual(memberValues, ["off", "on"], "members enumerate the union arms as tagged string LiteralValues");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("opencanon analyze --typed ignores external declaration fingerprints", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-sidecar-external-"));
  const externalRoot = mkdtempSync(path.join(tmpdir(), "opencanon-external-types-"));
  try {
    linkWorkspaceTypeScript(rootDir);
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          baseUrl: ".",
          paths: { "external-types": [path.join(externalRoot, "types.d.ts")] },
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["src/**/*"],
      }),
    );
    writeFileSync(path.join(externalRoot, "types.d.ts"), 'export type Mode = "fast" | "slow";\n');
    writeFileSync(
      path.join(rootDir, "src/mode.ts"),
      [
        'import type { Mode } from "external-types";',
        "export function isFast(value: Mode) {",
        '  return value === "fast";',
        "}",
      ].join("\n"),
    );

    const analyzeUrl = new URL("../packages/cli/src/analyze.ts", import.meta.url).href;
    const { runAnalyzeCommand } = (await import(analyzeUrl)) as typeof import("../packages/cli/src/analyze.ts");
    await runAnalyzeCommand(["--typed"], rootDir);
    const sidecarPath = path.join(rootDir, ".opencanon", "cache", "typed-comparisons.json");
    const payload = JSON.parse(readFileSync(sidecarPath, "utf8"));
    assert(payload.entries.some((entry: { display: string }) => entry.display === "Mode"));
    assert(
      payload.sourceFiles.every((source: { path: string }) => !path.isAbsolute(source.path) && !source.path.startsWith("../")),
      `sidecar must not persist external source paths: ${JSON.stringify(payload.sourceFiles)}`,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("declarationSourceId does not tag non-literal type aliases or property keys", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-literal-source-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "src/literals.ts"),
      [
        "type Alias = SomeOtherType;",
        "type Status = 'on' | 'off';",
        "export const Sort = {",
        "  'createdAt': 'createdAt',",
        "  updatedAt: 'updatedAt',",
        "} as const;",
      ].join("\n"),
    );
    const ctx = createValidationContext({
      rootDir,
      paths: createPaths(rootDir),
      files: ["src/literals.ts"],
      validator: { id: "literal-source-test", severity: "warning" },
    });
    const literals = ctx.facts.literals();

    assert(!literals.some((lit) => lit.declarationSourceId === "Alias"), "non-literal alias must not tag literals");

    const statusValues = literals.filter((lit) => lit.declarationSourceId === "Status").map((lit) => lit.value).sort();
    assert.deepEqual(statusValues, ["off", "on"]);

    const taggedSortValues = literals.filter((lit) => lit.declarationSourceId === "Sort").map((lit) => lit.value);
    assert(taggedSortValues.includes("createdAt"));
    assert(taggedSortValues.includes("updatedAt"));
    assert.equal(taggedSortValues.filter((v) => v === "createdAt").length, 1, "key occurrence of 'createdAt' must not be tagged");
    flushValidationContextCache(ctx);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readSidecarPayloadDetailed enforces content-addressed freshness", async () => {
  const { readSidecarPayloadDetailed } = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-sidecar-neg-"));
  try {
    const cacheDir = path.join(rootDir, ".opencanon", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const sidecarPath = path.join(cacheDir, "typed-comparisons.json");

    // Real analyzed source file the sidecar fingerprints.
    const srcPath = path.join(rootDir, "src.ts");
    const srcText = "export type Status = 'on' | 'off';\n";
    writeFileSync(srcPath, srcText);
    const srcHash = createHashHex(srcText);
    const srcStat = statSync(srcPath);

    const expect = {
      rootDir,
      tsconfigHash: (_p: string) => "matching-hash",
      tsVersion: () => "5.9.0",
    };
    const freshPayload = () => ({
      version: 1 as const,
      generatedAt: "2026-01-01T00:00:00Z",
      tsconfigPath: "tsconfig.json",
      tsconfigHash: "matching-hash",
      tsVersion: "5.9.0",
      gitHead: "anything-metadata-only",
      sourceFiles: [{ path: "src.ts", sha256: srcHash, mtimeMs: srcStat.mtimeMs, size: srcStat.size }],
      membershipHash: "m",
      coverage: { programFiles: 1, comparisonSites: 0, checkedSites: 0 },
      entries: [],
    });

    // 1. Fresh → loads.
    writeFileSync(sidecarPath, JSON.stringify(freshPayload()));
    assert.equal(readSidecarPayloadDetailed(sidecarPath, expect).staleReason, null, "fresh payload should load");

    // 2. gitHead is metadata only — a different value must NOT reject.
    writeFileSync(sidecarPath, JSON.stringify({ ...freshPayload(), gitHead: "totally-different" }));
    assert.equal(readSidecarPayloadDetailed(sidecarPath, expect).staleReason, null, "gitHead must not gate freshness");

    // 3. tsconfigHash mismatch → reject.
    writeFileSync(sidecarPath, JSON.stringify({ ...freshPayload(), tsconfigHash: "stale" }));
    assert.equal(readSidecarPayloadDetailed(sidecarPath, expect).staleReason, "tsconfig");

    // 4. tsVersion mismatch → reject.
    writeFileSync(sidecarPath, JSON.stringify({ ...freshPayload(), tsVersion: "5.0.0" }));
    assert.equal(readSidecarPayloadDetailed(sidecarPath, expect).staleReason, "ts-version");

    // 5. Source content drift (edit the file) → reject. This is the mid-commit hole.
    writeFileSync(sidecarPath, JSON.stringify(freshPayload()));
    writeFileSync(srcPath, "export type Status = 'on' | 'off' | 'pending';\n");
    assert.equal(readSidecarPayloadDetailed(sidecarPath, expect).staleReason, "source-drift", "editing a source file must invalidate");

    // 6. Deleted source file → reject.
    rmSync(srcPath);
    writeFileSync(sidecarPath, JSON.stringify(freshPayload()));
    assert.equal(readSidecarPayloadDetailed(sidecarPath, expect).staleReason, "source-drift");

    // 7. Malformed JSON → reject.
    writeFileSync(sidecarPath, "{ not valid json");
    assert.equal(readSidecarPayloadDetailed(sidecarPath, expect).staleReason, "malformed");

    // 8. Wrong version → reject.
    writeFileSync(sidecarPath, JSON.stringify({ ...freshPayload(), version: 2 }));
    assert.equal(readSidecarPayloadDetailed(sidecarPath, expect).staleReason, "version");

    // 9. Missing membershipHash → reject.
    writeFileSync(srcPath, srcText);
    const { membershipHash: _omit, ...noMembership } = freshPayload();
    void _omit;
    writeFileSync(sidecarPath, JSON.stringify(noMembership));
    assert.equal(readSidecarPayloadDetailed(sidecarPath, expect).staleReason, "version");

    // 10. Membership drift (added/removed ambient file) → reject, only when the caller supplies the current hash.
    writeFileSync(sidecarPath, JSON.stringify(freshPayload())); // membershipHash: "m"
    assert.equal(readSidecarPayloadDetailed(sidecarPath, { ...expect, membershipHash: "m" }).staleReason, null, "matching membership loads");
    assert.equal(readSidecarPayloadDetailed(sidecarPath, { ...expect, membershipHash: "different" }).staleReason, "membership-drift");
    // Without a supplied hash, membership is not gated (per-validation path).
    assert.equal(readSidecarPayloadDetailed(sidecarPath, expect).staleReason, null, "membership not gated when hash omitted");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("opencanon analyze --typed fails loudly on invalid tsconfig and empty resolution", async () => {
  const analyzeUrl = new URL("../packages/cli/src/analyze.ts", import.meta.url).href;
  const { runAnalyzeCommand } = (await import(analyzeUrl)) as typeof import("../packages/cli/src/analyze.ts");

  const badRoot = mkdtempSync(path.join(tmpdir(), "opencanon-analyze-bad-"));
  try {
    linkWorkspaceTypeScript(badRoot);
    writeFileSync(path.join(badRoot, "tsconfig.json"), "{ not valid json");
    let threw = false;
    try {
      await runAnalyzeCommand(["--typed"], badRoot);
    } catch {
      threw = true;
    }
    assert(threw, "analyze --typed must throw on malformed tsconfig");
    assert(!existsSync(path.join(badRoot, ".opencanon", "cache", "typed-comparisons.json")), "no sidecar should be written");
  } finally {
    rmSync(badRoot, { recursive: true, force: true });
  }

  const emptyRoot = mkdtempSync(path.join(tmpdir(), "opencanon-analyze-empty-"));
  try {
    linkWorkspaceTypeScript(emptyRoot);
    writeFileSync(path.join(emptyRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: { noEmit: true, skipLibCheck: true },
      include: [],
      files: [],
    }));
    let threw = false;
    try {
      await runAnalyzeCommand(["--typed"], emptyRoot);
    } catch {
      threw = true;
    }
    assert(threw, "analyze --typed must throw when tsconfig resolves zero files");
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("C3: sidecar with an absolute or escaping source path is rejected (treated stale)", async () => {
  const { readSidecarPayloadDetailed } = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-c3-traversal-"));
  try {
    const sidecarPath = path.join(rootDir, "sidecar.json");
    const expected = {
      rootDir,
      tsconfigHash: () => "irrelevant",
      tsVersion: () => null,
    };

    // (a) Absolute tsconfigPath → rejected before any FS access.
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        version: 1,
        generatedAt: "x",
        tsconfigPath: "/etc/passwd",
        tsconfigHash: "h",
        tsVersion: "6.0.0",
        gitHead: "",
        sourceFiles: [],
        membershipHash: "m",
        coverage: { programFiles: 0, comparisonSites: 0, checkedSites: 0 },
        entries: [],
      }),
    );
    let result = readSidecarPayloadDetailed(sidecarPath, expected);
    assert.equal(result.payload, null, "absolute tsconfigPath must be rejected");
    assert.equal(result.staleReason, "malformed");

    // (b) Escaping ../ source path → rejected.
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        version: 1,
        generatedAt: "x",
        tsconfigPath: "tsconfig.json",
        tsconfigHash: "h",
        tsVersion: "6.0.0",
        gitHead: "",
        sourceFiles: [{ path: "../../../../etc/passwd", sha256: "x", mtimeMs: 0, size: 0 }],
        membershipHash: "m",
        coverage: { programFiles: 0, comparisonSites: 0, checkedSites: 0 },
        entries: [],
      }),
    );
    result = readSidecarPayloadDetailed(sidecarPath, expected);
    assert.equal(result.payload, null, "escaping source path must be rejected");
    assert.equal(result.staleReason, "malformed");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("C4: a throwing type-facts provider records crashed status and no checked facts", async () => {
  const { prewarmContextTypeFacts, createValidationContext } = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-c4-prewarm-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/a.ts"), 'function f(m: "x" | "y") { return m === "x"; }\n');
    const ctx = createValidationContext({
      rootDir,
      files: ["src/a.ts"],
      targetFiles: ["src/a.ts"],
      analysisFiles: ["src/a.ts"],
      validator: { id: "c4", severity: "error" },
    });
    const throwingProvider = {
      language: "typescript" as const,
      status() {
        return { language: "typescript" as const, kind: "ready" as const };
      },
      factGeneration() {
        return undefined;
      },
      resolveTypes() {
        throw new Error("provider boom");
      },
    };
    // Must resolve (not reject), install an empty map, and record explicit crashed status.
    await prewarmContextTypeFacts(ctx, throwingProvider);
    const literals = ctx.typed.literal({ surroundingTypeName: "x" });
    assert.equal(literals.length, 0, "no facts when the provider throws");
    assert.equal(ctx.typed.producerStatus("typescript").kind, "crashed");
    assert.match(ctx.typed.producerStatus("typescript").detail ?? "", /provider boom/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("H1: non-git root yields a non-empty membership set via fs fallback", async () => {
  const { listMembershipFiles, membershipHashOf } = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-h1-nogit-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(rootDir, "src/b.tsx"), "export const b = 2;\n");
    writeFileSync(path.join(rootDir, "README.md"), "# x\n");
    // No `git init` → git ls-files fails → fs fallback.
    const files = listMembershipFiles(rootDir);
    assert.deepEqual(files.sort(), ["src/a.ts", "src/b.tsx"], "fs fallback finds TS/TSX, not the .md");

    // A sidecar built for a DIFFERENT file set is rejected via membership-drift.
    const builtForDifferentSet = membershipHashOf(["src/a.ts"]);
    const currentHash = membershipHashOf(files);
    assert.notEqual(builtForDifferentSet, currentHash, "different membership sets hash differently (not both empty)");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("H2: a multi-validator run issues a single resolveTypes batch", async () => {
  const { resolveRunTypeFacts, createValidationContext } = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-h2-batch-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/a.ts"), 'function f(m: "x" | "y") { return m === "x"; }\n');
    writeFileSync(path.join(rootDir, "src/b.ts"), 'function g(n: "p" | "q") { return n === "p"; }\n');
    const makeCtx = (file: string) =>
      createValidationContext({
        rootDir,
        files: [file],
        targetFiles: [file],
        analysisFiles: [file],
        validator: { id: file, severity: "error" },
      });
    const contexts = [makeCtx("src/a.ts"), makeCtx("src/b.ts")];

    // Count how many times resolveTypes is called by installing a stub provider.
    let calls = 0;
    let lastSiteCount = 0;
    const provider = {
      language: "typescript" as const,
      status() {
        return { language: "typescript" as const, kind: "ready" as const };
      },
      factGeneration() {
        return undefined;
      },
      async resolveTypes(sites: { file: string; line: number; column: number }[]) {
        calls += 1;
        lastSiteCount = sites.length;
        return new Map();
      },
    };
    const facts = await resolveRunTypeFacts(contexts, provider);
    assert.equal(facts.statuses[0]?.kind, "ready");
    assert.equal(calls, 1, "exactly one resolveTypes batch for the whole run");
    assert.equal(lastSiteCount, 2, "the single batch carries the union of both contexts' sites");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a requiresProducers validator skips with a diagnostic when its producer isn't ready; --strict-producers escalates", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-requires-producers-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const targetFile = "src/a.ts";
    // No tsconfig + no sidecar in this temp root → the typescript producer is NOT ready.
    writeFileSync(path.join(rootDir, targetFile), 'export function f(m: "x" | "y") { return m === "x"; }\n');
    const paths = createPaths(rootDir);
    let ran = false;
    const validators = resolveTestValidators(
      testValidatorDefinition({
        id: "needs-ts",
        severity: "warning",
        scope: "file",
        applies: ["src/**"],
        requiresProducers: ["typescript"],
        validate() {
          ran = true;
          return [];
        },
      }),
    ).validators;

    // Non-strict: validator skips. The skip is a validatorOutcome, NOT a finding
    // (findings are code-only). The body never runs and findings count excludes it.
    const result = await runValidation({ rootDir, paths, conventions: [], validators, files: [targetFile], producerPolicy: BatchProducerPolicy });
    assert.equal(ran, false, "the validator body must not run when its producer is unmet");
    assert.equal(result.findings.length, 0, "a producer skip must NOT appear as a finding");
    assert.equal(result.findingCount, 0, "findings count excludes outcomes");
    const skip = result.validatorOutcomes.find((outcome) => outcome.validatorId === "needs-ts");
    assert.ok(skip, "a producer-skip outcome is emitted");
    assert.equal(skip!.status, "skipped");
    assert.equal(skip!.producer?.language, "typescript");
    assert.match(skip!.reason ?? "", /typescript producer/);

    // Strict only changes the exit-code semantics (the outcome itself is still a
    // skip); confirm the outcome is present and producer-anchored.
    ran = false;
    const strict = await runValidation({ rootDir, paths, conventions: [], validators, files: [targetFile], strictProducers: true, producerPolicy: BatchProducerPolicy });
    assert.equal(ran, false);
    const strictSkip = strict.validatorOutcomes.find((outcome) => outcome.validatorId === "needs-ts");
    assert.ok(strictSkip);
    assert.equal(strictSkip!.status, "skipped");
    assert.ok(strictSkip!.producer, "skip outcome carries the producer (language+generation)");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("H1: a producer that crashes DURING the run's resolveTypes records non-ready status, so requiresProducers validators skip loudly (no silent 0 findings)", async () => {
  const core = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-h1-crash-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const targetFile = "src/a.ts";
    writeFileSync(path.join(rootDir, targetFile), 'export function f(m: "x" | "y") { return m === "x"; }\n');
    const paths = createPaths(rootDir);

    // Stub live provider mirroring the runtime contract: status() is `ready`
    // until a query crashes, after which it reports `crashed` — the crash is set
    // BEFORE resolveTypes resolves (the runtime sets lastCrash in its catch then
    // returns []). resolveTypes succeeds-but-empty here to model the runtime's
    // empty-facts plus crashed-status contract.
    let crashed = false;
    core.setLiveTypeFactsProviderFactory(() => ({
      language: "typescript" as const,
      status() {
        return crashed
          ? { language: "typescript" as const, kind: "crashed" as const, detail: "query failed" }
          : { language: "typescript" as const, kind: "ready" as const };
      },
      factGeneration() {
        return undefined;
      },
      async resolveTypes() {
        crashed = true; // crash recorded before this resolves, just like the runtime
        return new Map();
      },
    }));

    let ran = false;
    const validators = resolveTestValidators(
      testValidatorDefinition({
        id: "needs-ts",
        severity: "warning",
        scope: "file",
        applies: ["src/**"],
        requiresProducers: ["typescript"],
        validate() {
          ran = true;
          return [];
        },
      }),
    ).validators;

    try {
      const result = await runValidation({ rootDir, paths, conventions: [], validators, files: [targetFile], producerPolicy: InteractiveProducerPolicy });
      assert.equal(ran, false, "the run-query crash must surface as non-ready so the validator skips (not silent 0 findings)");
      assert.equal(result.findings.length, 0, "a producer skip is never a finding");
      const skip = result.validatorOutcomes.find((outcome) => outcome.validatorId === "needs-ts");
      assert.ok(skip, "a producer-skip outcome is emitted for the crashed producer");
      assert.equal(skip!.status, "skipped");
      assert.match(skip!.reason ?? "", /typescript producer crashed/);
    } finally {
      core.setLiveTypeFactsProviderFactory(undefined);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provider throw synthesizes crashed producer status so required validators skip", async () => {
  const core = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-provider-throw-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const targetFile = "src/a.ts";
    writeFileSync(path.join(rootDir, targetFile), 'export function f(m: "x" | "y") { return m === "x"; }\n');
    const paths = createPaths(rootDir);

    core.setLiveTypeFactsProviderFactory(() => ({
      language: "typescript" as const,
      status() {
        return { language: "typescript" as const, kind: "ready" as const };
      },
      factGeneration() {
        return undefined;
      },
      async resolveTypes() {
        throw new Error("producer exploded");
      },
    }));

    let ran = false;
    const validators = resolveTestValidators(
      testValidatorDefinition({
        id: "needs-ts-throw",
        severity: "warning",
        scope: "file",
        applies: ["src/**"],
        requiresProducers: ["typescript"],
        validate() {
          ran = true;
          return [];
        },
      }),
    ).validators;

    try {
      const result = await runValidation({ rootDir, paths, conventions: [], validators, files: [targetFile], producerPolicy: InteractiveProducerPolicy });
      assert.equal(ran, false, "a thrown producer query must not let required validators run against empty facts");
      const skip = result.validatorOutcomes.find((outcome) => outcome.validatorId === "needs-ts-throw");
      assert.ok(skip, "a producer-skip outcome is emitted for the thrown provider");
      assert.equal(skip!.status, "skipped");
      assert.match(skip!.reason ?? "", /typescript producer crashed/);
      assert.match(skip!.reason ?? "", /producer exploded/);
    } finally {
      core.setLiveTypeFactsProviderFactory(undefined);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("H2: a validator that queries surroundingTypeName WITHOUT requiresProducers emits a validator-runtime diagnostic when the producer is non-ready (not silent)", async () => {
  const core = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-h2-forgetful-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const targetFile = "src/a.ts";
    writeFileSync(path.join(rootDir, targetFile), 'export function f(m: "x" | "y") { return m === "x"; }\n');
    const paths = createPaths(rootDir);

    // Producer present but NOT ready (disabled) — and it returns no facts.
    core.setLiveTypeFactsProviderFactory(() => ({
      language: "typescript" as const,
      status() {
        return { language: "typescript" as const, kind: "disabled" as const, detail: "OPENCANON_TYPED_PRODUCER=off" };
      },
      factGeneration() {
        return undefined;
      },
      async resolveTypes() {
        return new Map();
      },
    }));

    const validators = resolveTestValidators(
      testValidatorDefinition({
        id: "forgetful-rule",
        severity: "warning",
        scope: "file",
        applies: ["src/**"],
        // NOTE: no requiresProducers — this is the forgetful author.
        validate({ ctx }) {
          ctx.typed.literal({ surroundingTypeName: "X" });
          return [];
        },
      }),
    ).validators;

    try {
      const result = await runValidation({ rootDir, paths, conventions: [], validators, files: [targetFile], producerPolicy: InteractiveProducerPolicy });
      assert.equal(result.findings.length, 0, "forgetful-author usage is an outcome, never a finding");
      const warn = result.validatorOutcomes.find(
        (outcome) => outcome.validatorId === "forgetful-rule" && /forgetful-rule used typed facts for typescript/.test(outcome.reason ?? ""),
      );
      assert.ok(warn, "a forgetful-author outcome is emitted instead of a silent clean result");
      assert.equal(warn!.status, "skipped");
      assert.match(warn!.reason ?? "", /does not declare requiresProducers/);

      // Strict escalates the same outcome to an error status.
      const strict = await runValidation({ rootDir, paths, conventions: [], validators, files: [targetFile], strictProducers: true, producerPolicy: InteractiveProducerPolicy });
      const strictWarn = strict.validatorOutcomes.find(
        (outcome) => outcome.validatorId === "forgetful-rule" && /forgetful-rule used typed facts for typescript/.test(outcome.reason ?? ""),
      );
      assert.ok(strictWarn);
      assert.equal(strictWarn!.status, "error");
    } finally {
      core.setLiveTypeFactsProviderFactory(undefined);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CRITICAL1: reading literal.surroundingType records consumption even when the producer is non-ready (no silent zero); a validator that never reads it records nothing", async () => {
  const core = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-c1-surrounding-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const targetFile = "src/a.ts";
    writeFileSync(path.join(rootDir, targetFile), 'export function f(m: "x" | "y") { return m === "x"; }\n');
    const paths = createPaths(rootDir);

    // (a) Producer present but STALE — the type map is empty, so surroundingType
    // resolves to undefined. The validator reads it anyway (the vulnerable shape:
    // ctx.typed.literal({ contexts, valueKind }) + literal.surroundingType), with
    // NO requiresProducers and NO surroundingTypeName. The OLD guard saw no result
    // carrying surroundingType -> recorded nothing -> silently returned 0 findings.
    core.setLiveTypeFactsProviderFactory(() => ({
      language: "typescript" as const,
      status() {
        return { language: "typescript" as const, kind: "stale" as const, detail: "source-drift" };
      },
      factGeneration() {
        return undefined;
      },
      async resolveTypes() {
        return new Map();
      },
    }));

    const readingValidators = resolveTestValidators(
      testValidatorDefinition({
        id: "reads-surrounding-rule",
        severity: "warning",
        scope: "file",
        applies: ["src/**"],
        // NOTE: no requiresProducers, no surroundingTypeName filter.
        validate({ ctx }) {
          for (const literal of ctx.typed.literal({ contexts: ["comparison"], valueKind: "string" })) {
            // Reading surroundingType (resolves undefined here) MUST record consumption.
            void literal.surroundingType;
          }
          return [];
        },
      }),
    ).validators;

    try {
      const result = await runValidation({ rootDir, paths, conventions: [], validators: readingValidators, files: [targetFile], producerPolicy: InteractiveProducerPolicy });
      assert.equal(result.findings.length, 0, "no findings — the producer-enriched data was empty");
      const warn = result.validatorOutcomes.find(
        (outcome) =>
          outcome.validatorId === "reads-surrounding-rule" && /reads-surrounding-rule used typed facts for typescript/.test(outcome.reason ?? ""),
      );
      assert.ok(warn, "reading surroundingType under a non-ready producer must emit a validator-runtime outcome, not silently return 0");
      assert.equal(warn!.status, "skipped");
      assert.match(warn!.reason ?? "", /does not declare requiresProducers/);
    } finally {
      core.setLiveTypeFactsProviderFactory(undefined);
    }

    // (b) A validator that NEVER touches surroundingType (only value/line) records
    // nothing — no false forgetful-author outcome, even with the same producer.
    core.setLiveTypeFactsProviderFactory(() => ({
      language: "typescript" as const,
      status() {
        return { language: "typescript" as const, kind: "stale" as const, detail: "source-drift" };
      },
      factGeneration() {
        return undefined;
      },
      async resolveTypes() {
        return new Map();
      },
    }));

    const nonReadingValidators = resolveTestValidators(
      testValidatorDefinition({
        id: "no-surrounding-rule",
        severity: "warning",
        scope: "file",
        applies: ["src/**"],
        validate({ ctx }) {
          for (const literal of ctx.typed.literal({ contexts: ["comparison"], valueKind: "string" })) {
            // Reads only syntactic fields; never touches surroundingType.
            void literal.value;
            void literal.line;
          }
          return [];
        },
      }),
    ).validators;

    try {
      const result = await runValidation({ rootDir, paths, conventions: [], validators: nonReadingValidators, files: [targetFile], producerPolicy: InteractiveProducerPolicy });
      const falseWarn = result.validatorOutcomes.find(
        (outcome) => outcome.validatorId === "no-surrounding-rule" && /used typed facts/.test(outcome.reason ?? ""),
      );
      assert.equal(falseWarn, undefined, "a validator that never reads surroundingType must NOT record consumption (no false warning)");
    } finally {
      core.setLiveTypeFactsProviderFactory(undefined);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("--strict-producers exit code is driven by validatorOutcomes, not findings", async () => {
  const validateUrl = new URL("../packages/cli/src/validate.ts", import.meta.url).href;
  const { validationExitCode } = (await import(validateUrl)) as typeof import("../packages/cli/src/validate.ts");
  const base = {
    files: [],
    validators: ["needs-ts"],
    validatorGraphHash: "sha256:test",
    findingCount: 0,
    diagnostics: [],
    findings: [],
    commitGates: [],
    producerSnapshot: { typescript: { kind: "warming" as const, generation: 0 } },
  };
  const skipResult = {
    ...base,
    validatorOutcomes: [
      { validatorId: "needs-ts", status: "skipped" as const, reason: "typescript producer warming", producer: { language: "typescript", generation: 0 } },
    ],
  };
  // Plain skip is advisory: exit 0 without --strict-producers.
  assert.equal(validationExitCode(skipResult, { changed: false, strictWarnings: false, strictProducers: false }), 0);
  // --strict-producers escalates a producer skip to nonzero.
  assert.equal(validationExitCode(skipResult, { changed: false, strictWarnings: false, strictProducers: true }), 1);
  // A validator-runtime error outcome is always nonzero, even without strict.
  const errorResult = {
    ...base,
    validatorOutcomes: [{ validatorId: "bad-rule", status: "error" as const, reason: "needs a non-empty question" }],
  };
  assert.equal(validationExitCode(errorResult, { changed: false, strictWarnings: false, strictProducers: false }), 1);
  // A clean run with only `ran` outcomes exits 0.
  const ranResult = { ...base, validatorOutcomes: [{ validatorId: "needs-ts", status: "ran" as const }] };
  assert.equal(validationExitCode(ranResult, { changed: false, strictWarnings: false, strictProducers: true }), 0);
});

test("single resolver: a ready live producer beats a stale sidecar candidate (precedence kills defect #2)", () => {
  const liveReady = { language: "typescript" as const, kind: "ready" as const, generation: 7 };
  const sidecarStale = { language: "typescript" as const, kind: "stale" as const, detail: "sidecar out of date" };
  assert.equal(pickAuthoritativeStatus([sidecarStale, liveReady]).kind, "ready");
  assert.equal(pickAuthoritativeStatus([liveReady, sidecarStale]).kind, "ready");
  const liveWarming = { language: "typescript" as const, kind: "warming" as const, generation: 0 };
  assert.equal(pickAuthoritativeStatus([sidecarStale, liveWarming]).kind, "warming");
  assert.equal(pickAuthoritativeStatus([sidecarStale]).kind, "stale");
});

test("ValidationResult.producerSnapshot records the producer kind + generation actually used (codex #5)", async () => {
  const core = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-prodsnap-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const targetFile = "src/a.ts";
    writeFileSync(path.join(rootDir, targetFile), 'export function f(m: "x" | "y") { return m === "x"; }\n');
    const paths = createPaths(rootDir);
    core.setLiveTypeFactsProviderFactory(() => ({
      language: "typescript" as const,
      status() {
        return { language: "typescript" as const, kind: "ready" as const, generation: 42 };
      },
      factGeneration() {
        // No facts resolved in this stub → snapshot falls back to status gen 42.
        return undefined;
      },
      async resolveTypes() {
        return new Map();
      },
    }));
    const validators = resolveTestValidators(
      testValidatorDefinition({ id: "noop", severity: "warning", scope: "file", applies: ["src/**"], validate: () => [] }),
    ).validators;
    try {
      const result = await runValidation({ rootDir, paths, conventions: [], validators, files: [targetFile], producerPolicy: InteractiveProducerPolicy });
      assert.deepEqual(result.producerSnapshot.typescript, { kind: "ready", generation: 42 });
    } finally {
      core.setLiveTypeFactsProviderFactory(undefined);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("audit C: producerSnapshot binds the generation the FACTS came from, not a newer status() that raced in (resolveTypes gen N, status N+1 -> snapshot N)", async () => {
  const core = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-factgen-race-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const targetFile = "src/a.ts";
    writeFileSync(path.join(rootDir, targetFile), 'export function f(m: "x" | "y") { return m === "x"; }\n');
    const paths = createPaths(rootDir);
    // The race: the live producer resolved this batch from generation N (=7),
    // carried in the resolveTypes response and recorded by factGeneration(). A
    // rebuild then advanced the producer to N+1 (=8), so status() — sampled
    // AFTER resolveTypes — reports generation 8. The snapshot must bind the
    // FACTS' generation (7), never the racing status generation (8).
    const factGen = 7;
    core.setLiveTypeFactsProviderFactory(() => ({
      language: "typescript" as const,
      status() {
        // Availability sampled later: a newer program (gen 8) is now ready.
        return { language: "typescript" as const, kind: "ready" as const, generation: factGen + 1 };
      },
      factGeneration() {
        // Bound atomically with the facts this run actually used.
        return factGen;
      },
      async resolveTypes() {
        return new Map();
      },
    }));
    const validators = resolveTestValidators(
      testValidatorDefinition({ id: "noop", severity: "warning", scope: "file", applies: ["src/**"], validate: () => [] }),
    ).validators;
    try {
      const result = await runValidation({ rootDir, paths, conventions: [], validators, files: [targetFile], producerPolicy: InteractiveProducerPolicy });
      // kind from authoritative status; generation from the facts (N), not N+1.
      assert.deepEqual(result.producerSnapshot.typescript, { kind: "ready", generation: factGen });
    } finally {
      core.setLiveTypeFactsProviderFactory(undefined);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("warming -> ready: a warming producer yields skipped(warming); re-running once ready flips the outcome to ran", async () => {
  const core = await import("@opencanon/core");
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-warming-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    const targetFile = "src/a.ts";
    writeFileSync(path.join(rootDir, targetFile), 'export function f(m: "x" | "y") { return m === "x"; }\n');
    const paths = createPaths(rootDir);
    let warmed = false;
    core.setLiveTypeFactsProviderFactory(() => ({
      language: "typescript" as const,
      status() {
        return warmed
          ? { language: "typescript" as const, kind: "ready" as const, generation: 1 }
          : { language: "typescript" as const, kind: "warming" as const, generation: 0 };
      },
      factGeneration() {
        return undefined;
      },
      async resolveTypes() {
        return new Map();
      },
    }));
    let ran = false;
    const validators = resolveTestValidators(
      testValidatorDefinition({
        id: "needs-ts",
        severity: "warning",
        scope: "file",
        applies: ["src/**"],
        requiresProducers: ["typescript"],
        validate() {
          ran = true;
          return [];
        },
      }),
    ).validators;
    try {
      const warming = await runValidation({ rootDir, paths, conventions: [], validators, files: [targetFile], producerPolicy: InteractiveProducerPolicy });
      assert.equal(ran, false);
      assert.equal(warming.findings.length, 0);
      const skip = warming.validatorOutcomes.find((outcome) => outcome.validatorId === "needs-ts");
      assert.equal(skip?.status, "skipped");
      assert.match(skip?.reason ?? "", /typescript producer warming/);
      assert.deepEqual(warming.producerSnapshot.typescript, { kind: "warming", generation: 0 });

      warmed = true;
      const ready = await runValidation({ rootDir, paths, conventions: [], validators, files: [targetFile], producerPolicy: InteractiveProducerPolicy });
      assert.equal(ran, true, "the validator runs once its producer is ready");
      const outcome = ready.validatorOutcomes.find((o) => o.validatorId === "needs-ts");
      assert.equal(outcome?.status, "ran");
      assert.deepEqual(ready.producerSnapshot.typescript, { kind: "ready", generation: 1 });
    } finally {
      core.setLiveTypeFactsProviderFactory(undefined);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("project validation can explicitly use the batch producer policy instead of a live producer", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-batch-producer-policy-"));
  try {
    const tsVersion = linkWorkspaceTypeScript(rootDir);
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    mkdirSync(path.join(rootDir, ".opencanon/cache"), { recursive: true });
    const targetFile = "src/a.ts";
    writeFileSync(path.join(rootDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }, null, 2));
    writeFileSync(path.join(rootDir, targetFile), 'export function f(m: "x" | "y") { return m === "x"; }\n');
    const { typedSidecarTsconfigHash, membershipHashOf, listMembershipFiles } = await import("@opencanon/core");
    const sourceStat = statSync(path.join(rootDir, targetFile));
    const sourceText = readFileSync(path.join(rootDir, targetFile), "utf8");
    writeFileSync(
      path.join(rootDir, ".opencanon/cache/typed-comparisons.json"),
      JSON.stringify(
        {
          version: 1,
          generatedAt: new Date().toISOString(),
          tsconfigPath: "tsconfig.json",
          tsconfigHash: typedSidecarTsconfigHash(rootDir),
          tsVersion,
          gitHead: "",
          sourceFiles: [
            {
              path: targetFile,
              sha256: createHashHex(sourceText),
              mtimeMs: sourceStat.mtimeMs,
              size: sourceStat.size,
            },
          ],
          membershipHash: membershipHashOf(listMembershipFiles(rootDir)),
          coverage: { programFiles: 1, comparisonSites: 1, checkedSites: 0 },
          entries: [],
        },
        null,
        2,
      ),
    );
    const paths = createPaths(rootDir);
    const core = await import("@opencanon/core");
    core.setLiveTypeFactsProviderFactory(() => ({
      language: "typescript" as const,
      status() {
        return { language: "typescript" as const, kind: "warming" as const, generation: 0 };
      },
      factGeneration() {
        return undefined;
      },
      async resolveTypes() {
        throw new Error("live producer should not be queried");
      },
    }));
    let ran = false;
    const validators = resolveTestValidators(
      testValidatorDefinition({
        id: "needs-ts",
        severity: "warning",
        scope: "file",
        applies: ["src/**"],
        requiresProducers: ["typescript"],
        validate() {
          ran = true;
          return [];
        },
      }),
    ).validators;
    try {
      const result = await runValidation({
        rootDir,
        paths,
        conventions: [],
        validators,
        project: true,
        producerPolicy: BatchProducerPolicy,
      });
      assert.equal(ran, true, "batch producer policy should ignore the warming live provider");
      const outcome = result.validatorOutcomes.find((item) => item.validatorId === "needs-ts");
      assert.equal(outcome?.status, "ran");
      assert.deepEqual(result.producerSnapshot.typescript, { kind: "ready", generation: 0 });
    } finally {
      core.setLiveTypeFactsProviderFactory(undefined);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("M1: invalid requiresProducers yields a validateContext diagnostic instead of silently disabling the gate", () => {
  assert.deepEqual(
    validateValidatorDefinitions({
      id: "bad-requires",
      topics: ["sample"],
      severity: "error",
      scope: "file",
      requiresProducers: [123],
      validate() {
        return [];
      },
    }),
    ["Validator bad-requires requiresProducers must be a non-empty string[] when present."],
  );

  assert.deepEqual(
    validateValidatorDefinitions({
      id: "empty-requires",
      topics: ["sample"],
      severity: "error",
      scope: "file",
      requiresProducers: [],
      validate() {
        return [];
      },
    }),
    ["Validator empty-requires requiresProducers must be a non-empty string[] when present."],
  );
});
