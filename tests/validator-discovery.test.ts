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
  utimesSync,
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

test("validation result cache invalidates same-size content changes with preserved mtime", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-validation-cache-content-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", projectFilePatterns: ["src/**/*.ts"], ignore: [] }));
    const filePath = path.join(rootDir, "src/company.ts");
    const firstText = "export const value = 'bad-a';\n";
    const secondText = "export const value = 'bad-b';\n";
    assert.equal(firstText.length, secondText.length);
    writeFileSync(filePath, firstText);
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(filePath, fixedTime, fixedTime);
    const paths = createPaths(rootDir);
    let runs = 0;

    const validators = resolveTestValidators(
      testValidatorDefinition({
        id: "content-sensitive-validator",
        applies: ["src/**/*.ts"],
        severity: "error",
        scope: "file",
        validate({ ctx }) {
          runs += 1;
          return ctx.targetFiles.map((file) =>
            file.report({
              line: 1,
              message: `${file.text.includes("bad-a") ? "first" : "second"} run ${runs}`,
            }),
          );
        },
      }),
    ).validators;

    const resultCache = createValidationResultCache(paths);
    const first = await runValidation({ rootDir, paths, conventions: [], validators, files: ["src/company.ts"], producerPolicy: BatchProducerPolicy, resultCache });
    assert.equal(runs, 1);
    assert.equal(first.findings[0]?.message, "first run 1");

    writeFileSync(filePath, secondText);
    utimesSync(filePath, fixedTime, fixedTime);
    const second = await runValidation({ rootDir, paths, conventions: [], validators, files: ["src/company.ts"], producerPolicy: BatchProducerPolicy, resultCache });
    assert.equal(runs, 2, "same-size and same-mtime content changes must bypass cached results");
    assert.equal(second.findings[0]?.message, "second run 2");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("validation result cache uses supplied project file fingerprints", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-validation-cache-fingerprints-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", projectFilePatterns: ["src/**/*.ts"], ignore: [] }));
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const value = 'same-file';\n");
    const paths = createPaths(rootDir);
    let runs = 0;

    const validators = resolveTestValidators(
      testValidatorDefinition({
        id: "supplied-fingerprint-validator",
        applies: ["src/**/*.ts"],
        severity: "error",
        scope: "file",
        validate({ ctx }) {
          runs += 1;
          return ctx.targetFiles.map((file) => file.report({ line: 1, message: `${file.path} run ${runs}` }));
        },
      }),
    ).validators;

    const resultCache = createValidationResultCache(paths);
    const first = await runValidation({
      rootDir,
      paths,
      conventions: [],
      validators,
      files: ["src/company.ts"],
      projectFileFingerprints: [{ path: "src/company.ts", exists: true, size: 32, contentHash: "runtime-content-one" }],
      producerPolicy: BatchProducerPolicy,
      resultCache,
    });
    assert.equal(runs, 1);
    assert.equal(first.findings[0]?.message, "src/company.ts run 1");

    const second = await runValidation({
      rootDir,
      paths,
      conventions: [],
      validators,
      files: ["src/company.ts"],
      projectFileFingerprints: [{ path: "src/company.ts", exists: true, size: 32, contentHash: "runtime-content-two" }],
      producerPolicy: BatchProducerPolicy,
      resultCache,
    });
    assert.equal(runs, 2, "runtime-owned content fingerprint changes must invalidate cached results even when file bytes are unchanged");
    assert.equal(second.findings[0]?.message, "src/company.ts run 2");
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
