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
  const { requireReadyProducers, validationExitCode } = (await import(validateUrl)) as typeof import("../packages/cli/src/validate.ts");
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

  const requiredWarming = requireReadyProducers(skipResult, ["typescript"]);
  assert.equal(validationExitCode(requiredWarming, { changed: false, strictWarnings: false, strictProducers: false }), 1);
  assert.deepEqual(requiredWarming.producerSnapshot, skipResult.producerSnapshot);
  assert.match(requiredWarming.diagnostics[0] ?? "", /typescript.*warming.*generation 0/);

  const requiredMissing = requireReadyProducers(ranResult, ["python"]);
  assert.equal(validationExitCode(requiredMissing, { changed: false, strictWarnings: false, strictProducers: false }), 1);
  assert.match(requiredMissing.diagnostics[0] ?? "", /python.*not-implemented/);

  const requiredReady = requireReadyProducers(
    { ...ranResult, producerSnapshot: { typescript: { kind: "ready" as const, generation: 9 } } },
    ["typescript"],
  );
  assert.equal(requiredReady.diagnostics.length, 0);
  assert.equal(validationExitCode(requiredReady, { changed: false, strictWarnings: false, strictProducers: false }), 0);
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
