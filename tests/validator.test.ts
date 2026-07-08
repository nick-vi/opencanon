import {
  assert,
  spawnSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  tmpdir,
  path,
  test,
  applyDoctorFixes,
  applyFindingFixes,
  BatchProducerPolicy,
  buildDoctorReport,
  createCommitApprovalContext,
  createCommitApprovalRecord,
  createConventionFactory,
  createHashHex,
  createPaths,
  createRuntime,
  createValidationContext,
  createValidationResultCache,
  defineArea,
  defineConvention,
  discoverProjectFiles,
  DoctorStatus,
  FixModeValue,
  flushValidationContextCache,
  generateProjectTypes,
  getChangedFiles,
  git,
  initGitRepo,
  InteractiveProducerPolicy,
  isolatedCliEnv,
  linkWorkspaceTypeScript,
  LiteralContext,
  LiteralValueKind,
  loadCommitApprovalsWithDiagnostics,
  OpenCanonSkillFilePath,
  pickAuthoritativeStatus,
  ProjectTypesFilePath,
  renderOpenCanonAgentEntryBlock,
  resolveCommitGates,
  resolveTestValidators,
  runValidation,
  savePendingCommitGates,
  stopIsolatedCliRuntime,
  testValidatorDefinition,
  toPendingCommitGates,
  upsertCommitApproval,
  validateConfig,
  validateContext,
  validateValidatorDefinitions,
  validatorGraphHash,
  ValidatorOutcomeStatus,
  externalCommand,
  externalDiagnostics,
  migrationReferences,
  noBypassComments,
  noHardcodedConfigValues,
  noHeaderComments,
  noSecretLikeLiterals,
  noUnusedExports,
  repeatedLiterals,
  requireExportPattern,
  requiredFileSibling,
  requiredFunctionParam,
  restrictedSymbols,
  similarFunctionNames,
} from "./validator-test-helpers.ts";

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
