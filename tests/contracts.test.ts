import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ContextRequestSchema,
  DaemonResponseSchema,
  ExtractFactsRequestSchema,
  ExtractFactsResultSchema,
  FileFactsSchema,
  CanonBundleSchema,
  EngineVersionSchema,
  EngineProjectStatusSchema,
  OpenCanonError,
  OpenProjectRequestSchema,
  SearchGraphEdgesRequestSchema,
  SearchGraphEdgesResultSchema,
  SearchReferencesRequestSchema,
  SearchReferencesResultSchema,
  ScanAndDiffResultSchema,
  ValidateRequestSchema,
  ValidatorContractSchema,
  WatcherEventBatchSchema,
  WatcherStartRequestSchema,
  createOpenCanonDiagnostic,
  createOpenCanonFailure,
  formatOpenCanonDiagnostics,
  matchesProjectFileScope,
  type ContextPaths,
} from "@opencanon/core";

test("file facts schema defaults optional fact arrays", () => {
  const facts = FileFactsSchema.parse({
    path: "src/company.ts",
    contentHash: "hash",
    language: "typescript",
    parser: "oxc",
    parserVersion: "0.128.0",
  });

  assert.deepEqual(facts.imports, []);
  assert.deepEqual(facts.exports, []);
  assert.deepEqual(facts.symbols, []);
  assert.deepEqual(facts.calls, []);
  assert.deepEqual(facts.literals, []);
  assert.deepEqual(facts.comments, []);
  assert.deepEqual(facts.diagnostics, []);
});

test("validator contract requires explicit scope", () => {
  assert.equal(
    ValidatorContractSchema.safeParse({
      id: "service-boundary",
      topics: ["service"],
      severity: "error",
      applies: ["src/services/**/*.ts"],
    }).success,
    false,
  );

  const validator = ValidatorContractSchema.parse({
    id: "service-boundary",
    topics: ["service"],
    severity: "error",
    scope: "import-edge",
    facts: ["imports"],
    applies: ["src/services/**/*.ts"],
    decisionIds: ["service-db-boundary"],
    docs: ["docs/opencanon/decisions.json#service-db-boundary"],
  });

  assert.equal(validator.scope, "import-edge");
  assert.deepEqual(validator.facts, ["imports"]);
  assert.deepEqual(validator.docs, ["docs/opencanon/decisions.json#service-db-boundary"]);
});

test("canon bundle contract supports typed options", () => {
  const bundle = CanonBundleSchema.parse({
    id: "project-rules",
    topics: ["project"],
    options: {
      sourceRoot: {
        type: "string",
        default: "src",
      },
      strictness: {
        type: "enum",
        values: ["advisory", "strict"],
        default: "advisory",
      },
    },
  });

  assert.equal(bundle.options.sourceRoot.default, "src");
  assert.equal(bundle.options.strictness.values?.includes("strict"), true);
  assert.deepEqual(bundle.docs, []);
  assert.deepEqual(bundle.externalTools, {});

  assert.equal(
    CanonBundleSchema.safeParse({
      id: "bad-bundle",
      topics: ["project"],
      options: {
        strictness: { type: "enum", default: "strict" },
      },
    }).success,
    false,
  );

  assert.equal(
    CanonBundleSchema.safeParse({
      id: "bad-default",
      topics: ["project"],
      options: {
        enabled: { type: "boolean", default: "yes" },
      },
    }).success,
    false,
  );
});

test("engine project contract parses fact requests and results", () => {
  assert.deepEqual(
    EngineVersionSchema.parse({
      packageVersion: "0.1.0",
      engineVersion: "0.1.0",
      napiVersion: "3.9.0",
      schemaVersion: 1,
    }).schemaVersion,
    1,
  );

  const request = ExtractFactsRequestSchema.parse({
    files: [{ path: "src/company.ts", contentHash: "hash", language: "typescript" }],
    facts: ["imports", "symbols"],
    parserVersion: "0.128.0",
  });
  assert.deepEqual(request.facts, ["imports", "symbols"]);

  const result = ExtractFactsResultSchema.parse({
    files: [
      {
        path: "src/company.ts",
        contentHash: "hash",
        language: "typescript",
        parser: "oxc",
        parserVersion: "0.128.0",
        imports: [{ source: "./dal", specifiers: ["findCompany"], kind: "import", resolution: "relative", line: 1 }],
      },
    ],
  });
  assert.equal(result.files[0].imports[0].source, "./dal");
});

test("code reference contracts parse indexed references", () => {
  assert.deepEqual(SearchReferencesRequestSchema.parse({ query: "logger", limit: 20 }), {
    query: "logger",
    limit: 20,
  });

  const result = SearchReferencesResultSchema.parse({
    references: [
      {
        id: "ref",
        path: "src/company.ts",
        language: "typescript",
        name: "logger",
        kind: "import-named",
        source: "./log",
        range: {
          start: { line: 1, column: 10, byte: 9 },
          end: { line: 1, column: 16, byte: 15 },
        },
        provenance: "oxc",
        confidence: "syntactic",
      },
    ],
  });

  assert.equal(result.references[0].source, "./log");
});

test("code graph edge contracts parse resolved edges", () => {
  assert.deepEqual(SearchGraphEdgesRequestSchema.parse({ query: "logger", direction: "incoming", limit: 20 }), {
    query: "logger",
    direction: "incoming",
    limit: 20,
  });

  const symbol = {
    id: "symbol",
    path: "src/company.ts",
    language: "typescript",
    kind: "function",
    name: "logger",
    qualifiedName: "src/company.ts::logger",
    exported: true,
    range: {
      start: { line: 1, column: 17, byte: 16 },
      end: { line: 1, column: 23, byte: 22 },
    },
  };
  const result = SearchGraphEdgesResultSchema.parse({
    edges: [
      {
        id: "edge",
        kind: "call",
        provenance: "oxc",
        confidence: "exact",
        path: "src/company.ts",
        range: { start: { line: 2, column: 3, byte: 32 } },
        source: { ...symbol, id: "source", name: "run", qualifiedName: "src/company.ts::run" },
        target: symbol,
      },
    ],
  });

  assert.equal(result.edges[0].target.name, "logger");
});

test("daemon request and response contracts have deterministic defaults", () => {
  assert.deepEqual(ValidateRequestSchema.parse({ changed: true }), {
    files: [],
    changed: true,
    all: false,
    strictWarnings: false,
    validatorIds: [],
    topics: [],
  });

  assert.deepEqual(ContextRequestSchema.parse({ query: "dal" }), {
    files: [],
    changed: false,
    query: "dal",
    topics: [],
  });

  const failure = DaemonResponseSchema.parse({
    ok: false,
    diagnostics: [
      {
        code: "daemon-not-running",
        message: "OpenCanon daemon is not running.",
        action: "Run opencanon daemon start.",
      },
    ],
  });

  assert.equal(failure.ok, false);
});

test("project scope filtering applies project patterns and ignores", () => {
  const paths: ContextPaths = {
    rootDir: "/repo",
    configPath: "/repo/opencanon.config.json",
    docsDir: "docs/opencanon",
    decisionsPath: "docs/opencanon/decisions.json",
    validatorsPath: ".agents/skills/opencanon/validators/index.ts",
    fixturesDir: ".agents/skills/opencanon/fixtures",
    impactSurfacesPath: "docs/opencanon/impact-surfaces.json",
    proposedImpactNotesPath: "docs/opencanon/proposed-impact-notes.json",
    baselinePath: ".opencanon/baseline.json",
    commitApprovalsPath: ".opencanon/commit-approvals.json",
    commitApprovalsPersistent: false,
    cacheDir: ".opencanon/cache",
    projectFilePatterns: ["src/**/*.ts", "tests/**/*.ts"],
    ignore: ["packages/**", ".agents/**"],
    entrypoints: [],
    publicSurfaces: [],
    generated: [],
    externalTools: {},
    requiredPackageScripts: ["opencanon"],
    fileDiscovery: "git",
    maxFiles: 20_000,
    maxFileSizeKb: 512,
  };

  assert.equal(matchesProjectFileScope(paths, "src/company.ts"), true);
  assert.equal(matchesProjectFileScope(paths, "packages/cli/src/index.ts"), false);
  assert.equal(matchesProjectFileScope(paths, ".agents/skills/opencanon/SKILL.md"), false);
  assert.equal(matchesProjectFileScope(paths, "README.md"), false);
});

test("engine project state contracts parse project handles and scan results", () => {
  const request = OpenProjectRequestSchema.parse({
    rootDir: "/repo",
    statePath: "/repo/.opencanon/state.sqlite",
    settings: {
      docsDir: "docs/opencanon",
      decisionsPath: "docs/opencanon/decisions.json",
      validatorsPath: ".agents/skills/opencanon/validators/index.ts",
      fixturesDir: ".agents/skills/opencanon/fixtures",
      projectFilePatterns: ["src/**/*.ts"],
      ignore: [".opencanon/**"],
      maxFiles: 20_000,
      maxFileSizeKb: 512,
      fileDiscovery: "git",
      configHash: "hash",
    },
  });
  const status = EngineProjectStatusSchema.parse({
    rootDir: request.rootDir,
    statePath: request.statePath,
    schemaVersion: 1,
    migrationsApplied: [1],
    watcher: { running: true, bufferedEvents: 0, stale: false },
  });
  const scan = ScanAndDiffResultSchema.parse({
    statePath: request.statePath,
    schemaVersion: status.schemaVersion,
    inventoryHash: "inventory",
    files: [{ path: "src/company.ts", contentHash: "hash", size: 42, stale: false }],
    changedFiles: ["src/company.ts"],
    unchangedFiles: [],
    deletedFiles: [],
    staleFiles: 0,
  });

  assert.equal(status.schemaVersion, 1);
  assert.equal(status.watcher.running, true);
  assert.equal(scan.changedFiles[0], "src/company.ts");
});

test("engine watcher contracts default options and parse event batches", () => {
  assert.deepEqual(WatcherStartRequestSchema.parse({}), {
    debounceMs: 250,
    bufferCapacity: 128,
  });

  const batch = WatcherEventBatchSchema.parse({
    rootDir: "/repo",
    paths: ["src/company.ts"],
    stale: false,
    timestamp: "123",
  });

  assert.equal(batch.paths[0], "src/company.ts");
});

test("open canon diagnostics are structured and formatted", () => {
  const diagnostic = createOpenCanonDiagnostic({
    code: "engine-binary-missing",
    message: "Engine binary is missing.",
    details: ["Expected packages/engine/binaries/opencanon.darwin-arm64.node."],
    action: "Run bun run build:engine.",
  });
  const failure = createOpenCanonFailure([diagnostic]);
  const error = new OpenCanonError([diagnostic]);

  assert.equal(failure.ok, false);
  assert(error.message.includes("[engine-binary-missing]"));
  assert(formatOpenCanonDiagnostics([diagnostic]).includes("Run bun run build:engine."));
});
