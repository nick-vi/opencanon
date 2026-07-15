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
import type { SemanticIndexSnapshot } from "@opencanon/core";

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
      summary: "Billing source is covered by Project Knowledge.",
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

test("doctor treats an idle on-demand producer as healthy", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-doctor-idle-producer-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), "{\"type\":\"module\",\"scripts\":{\"opencanon\":\"opencanon\"}}\n");
    writeFileSync(path.join(rootDir, "tsconfig.json"), "{\"include\":[\"src/**/*.ts\"]}\n");
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/index.ts"), "export const value = true;\n");
    const report = buildDoctorReport({
      paths: createPaths(rootDir),
      conventions: [],
      validators: [],
      producerStatuses: [{ language: "typescript", kind: "idle", detail: "starts on the next typed validation.", generation: 0 }],
    });
    const check = report.checks.find((item) => item.id === "type-producers");
    assert.equal(check?.status, "pass");
    assert(check?.details?.some((line) => line.includes("typescript: idle")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doctor reports Project Knowledge inspection outcomes explicitly", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-doctor-knowledge-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), "{\"type\":\"module\",\"scripts\":{\"opencanon\":\"opencanon\"}}\n");
    const base = { paths: createPaths(rootDir), conventions: [], validators: [] };

    const uninspected = buildDoctorReport(base).checks.find((item) => item.id === "semantic-index");
    assert.equal(uninspected?.status, DoctorStatus.Pass);
    assert.match(uninspected?.message ?? "", /not inspected.*no matching healthy project runtime/i);

    const missing = buildDoctorReport({
      ...base,
      knowledgeInspection: { kind: "available", index: null },
    }).checks.find((item) => item.id === "semantic-index");
    assert.equal(missing?.status, DoctorStatus.Warn);

    const indexing = buildDoctorReport({
      ...base,
      knowledgeInspection: { kind: "available", index: doctorKnowledgeSnapshot("indexing") },
    }).checks.find((item) => item.id === "semantic-index");
    assert.equal(indexing?.status, DoctorStatus.Warn);
    assert.match(indexing?.message ?? "", /indexing/i);

    const failedSnapshot = buildDoctorReport({
      ...base,
      knowledgeInspection: { kind: "available", index: doctorKnowledgeSnapshot("failed") },
    }).checks.find((item) => item.id === "semantic-index");
    assert.equal(failedSnapshot?.status, DoctorStatus.Fail);
    assert(failedSnapshot?.details?.some((detail) => detail.includes("without diagnostics")));

    const failedProbe = buildDoctorReport({
      ...base,
      knowledgeInspection: { kind: "failed", error: "pipe probe timed out" },
    });
    const failedProbeCheck = failedProbe.checks.find((item) => item.id === "semantic-index");
    assert.equal(failedProbe.status, DoctorStatus.Fail);
    assert.equal(failedProbeCheck?.status, DoctorStatus.Fail);
    assert.deepEqual(failedProbeCheck?.details, ["pipe probe timed out"]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function doctorKnowledgeSnapshot(status: SemanticIndexSnapshot["status"]): SemanticIndexSnapshot {
  return {
    id: "project",
    version: "semantic-index-v2",
    status,
    provider: {
      id: "native-test",
      kind: "native",
      modelId: "test-model",
      dimensions: 3,
      distance: "cosine",
      configHash: "test-config",
    },
    chunkerVersion: "test-chunker",
    producerVersion: "test-producer",
    sourceInventoryHash: "test-inventory",
    chunkTreeHash: "test-tree",
    identityHash: "test-identity",
    chunkCount: 1,
    vectorCount: 1,
    staleChunkCount: status === "stale" ? 1 : 0,
    indexedAt: "2026-07-13T00:00:00.000Z",
    diagnostics: [],
  };
}

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
    assert(gitignore.includes(".opencanon/processes/"));
    assert(gitignore.includes(".opencanon/check-*/"));
    assert(gitignore.includes(".opencanon/state/"));
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
}, 30_000);

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
}, 30_000);

test("Project Knowledge skips broken symlinks in ignored directories", () => {
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
