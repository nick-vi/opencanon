import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  applyDoctorFixes,
  applyFindingFixes,
  buildDoctorReport,
  createPaths,
  createRuntime,
  defineValidator,
  createValidatorFactory,
  createValidationContext,
  discoverProjectFiles,
  flushValidationContextCache,
  FixModeValue,
  getChangedFiles,
  resolveValidators,
  runValidation,
  validateConfig,
  validateContext,
  validateValidatorDefinitions,
} from "@opencanon/core";
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
} from "@opencanon/validators";

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
    ["Validator bad-facts facts must be known fact kinds: imports, exports, symbols, calls, literals, comments, references, annotations, diagnostics, duplicates."],
  );
});

test("validator definitions carry docs references through factory metadata", () => {
  const customFactory = createValidatorFactory<{ in: string[] }>((options) => ({
    id: options.id,
    topics: options.topics,
    applies: options.in,
    severity: options.severity,
    scope: "file",
    decisionIds: options.decisionIds,
    validate() {
      return [];
    },
  }));

  const resolved = resolveValidators(
    customFactory({
      id: "documented-rule",
      topics: ["sample"],
      severity: "warning",
      decisionIds: ["sample-decision"],
      docs: ["docs/opencanon/decisions.json#sample-decision"],
      in: ["src/**/*.ts"],
    }),
  );

  assert.deepEqual(resolved.diagnostics, []);
  assert.deepEqual(resolved.validators[0].docs, ["docs/opencanon/decisions.json#sample-decision"]);
});

test("context validation checks validator decision and docs references", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-context-links-"));
  try {
    mkdirSync(path.join(rootDir, "docs/opencanon/canon"), { recursive: true });
    writeFileSync(path.join(rootDir, "docs/opencanon/decisions.json"), "[]\n");
    writeFileSync(path.join(rootDir, "docs/opencanon/canon/architecture.md"), "# Architecture\n\n## Existing Heading\n\nCurrent docs.\n");
    const paths = createPaths(rootDir);
    const diagnostics = validateContext({
      paths,
      decisions: [
        {
          id: "current-decision",
          date: "2026-04-28",
          status: "current",
          title: "Current decision",
          topics: ["sample"],
          applies: ["src/**/*.ts"],
          summary: "Sample decision.",
          validatorIds: ["missing-validator"],
          docs: ["docs/opencanon/canon/architecture.md#missing-heading"],
        },
      ],
      validators: [
        {
          id: "sample-rule",
          decisionIds: ["missing-decision"],
          docs: ["docs/opencanon/decisions.json#missing-decision", "docs/opencanon/canon/architecture.md#missing-heading"],
        },
      ],
    });

    assert(diagnostics.includes("Decision current-decision references missing validator: missing-validator"));
    assert(diagnostics.includes("Decision current-decision docs reference points at missing heading: docs/opencanon/canon/architecture.md#missing-heading"));
    assert(diagnostics.includes("Validator sample-rule references missing decision: missing-decision"));
    assert(diagnostics.includes("Validator sample-rule docs reference points at missing decision: docs/opencanon/decisions.json#missing-decision"));
    assert(diagnostics.includes("Validator sample-rule docs reference points at missing heading: docs/opencanon/canon/architecture.md#missing-heading"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("context validation enforces decision and validator back-references", () => {
  const diagnostics = validateContext({
    decisions: [
      {
        id: "decision-a",
        date: "2026-04-28",
        status: "current",
        title: "Decision A",
        topics: ["sample"],
        applies: ["src/**/*.ts"],
        summary: "Decision A.",
        validatorIds: ["validator-a"],
      },
      {
        id: "decision-b",
        date: "2026-04-28",
        status: "current",
        title: "Decision B",
        topics: ["sample"],
        applies: ["src/**/*.ts"],
        summary: "Decision B.",
        validatorIds: [],
      },
    ],
    validators: [
      { id: "validator-a", decisionIds: [], docs: [] },
      { id: "validator-b", decisionIds: ["decision-b"], docs: [] },
    ],
  });

  assert(diagnostics.includes("Decision decision-a references validator validator-a, but validator validator-a does not reference decision decision-a."));
  assert(diagnostics.includes("Validator validator-b references decision decision-b, but decision decision-b does not reference validator validator-b."));
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
    const decisions = [
      {
        id: "sample-decision",
        date: "2026-04-28",
        status: "current" as const,
        title: "Sample decision",
        topics: ["sample"],
        applies: ["src/**/*.ts"],
        summary: "Sample decision.",
        validatorIds: ["broken-doc-finding"],
      },
    ];
    const validators = resolveValidators(
      defineValidator({
        id: "broken-doc-finding",
        topics: ["sample"],
        severity: "error",
        scope: "file",
        applies: ["src/**/*.ts"],
        decisionIds: ["sample-decision"],
        validate({ ctx }) {
          return ctx.targetFiles.map((file) =>
            file.report({
              line: 1,
              message: "Finding with broken refs.",
              docs: ["docs/opencanon/canon/architecture.md#missing-heading"],
              decisionIds: ["missing-decision"],
            }),
          );
        },
      }),
    ).validators;

    const result = await runValidation({ rootDir, paths, decisions, validators, files: ["src/a.ts"] });
    const runtimeMessages = result.findings.filter((finding) => finding.validatorId === "validator-runtime").map((finding) => finding.message);

    assert(runtimeMessages.includes("Finding from broken-doc-finding docs reference points at missing heading: docs/opencanon/canon/architecture.md#missing-heading"));
    assert(runtimeMessages.includes("Finding from broken-doc-finding references missing decision: missing-decision."));
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
            command: "bun run format",
          },
        },
      ],
    });

    assert.equal(result.appliedEdits, 0);
    assert.equal(result.skipped[0].reason, "Fix command is advisory and is not auto-executed: bun run format");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("validator summary callbacks resolve from effective metadata", () => {
  const resolved = resolveValidators(
    defineValidator({
      id: "parent-rule",
      topics: ["parent"],
      applies: ["src/**"],
      severity: "warning",
      scope: "file",
      facts: ["imports"],
      decisionIds: ["parent-decision"],
      validators: [
        defineValidator({
          id: "child-rule",
          topics: ["child"],
          applies: ["**/*.ts"],
          decisionIds: ["child-decision"],
          summary: ({ id, topics, applies, severity, scope, facts, decisionIds }) =>
            `${id} ${topics.join("+")} ${applies.join("|")} ${severity} ${scope} ${facts.join("+")} ${decisionIds.join("+")}`,
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

test("createValidatorFactory returns plain validator definitions", async () => {
  const noDebugFlag = createValidatorFactory<{ in: string[] }>(({ id, topics, severity, decisionIds, docs, in: applies }) => ({
    id,
    topics,
    severity,
    scope: "file",
    decisionIds,
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
    decisionIds: ["comments-current"],
    docs: ["docs/opencanon/decisions.json#comments-current"],
    in: ["src/**/*.{ts,tsx}"],
  });
  const resolved = resolveValidators(definition);
  assert.deepEqual(resolved.diagnostics, []);
  assert.equal(resolved.validators.length, 1);
  assert.equal(resolved.validators[0].id, "no-debugger");
  assert.equal(resolved.validators[0].scope, "file");
  assert.deepEqual(resolved.validators[0].topics, ["hygiene"]);
  assert.deepEqual(resolved.validators[0].decisionIds, ["comments-current"]);

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
    assert.equal(findings[0].docs?.[0], "docs/opencanon/decisions.json#comments-current");
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
    const resolved = resolveValidators(validator);
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
    const validator = resolveValidators(
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
    const validator = resolveValidators(
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

test("curated validators cover function params, siblings, and exports", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-curated-"));
  try {
    mkdirSync(path.join(rootDir, "src/services"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/services/company.service.ts"), "export function loadCompany(id: string) {\n  return id;\n}\n");
    const validators = resolveValidators([
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

    const resolved = resolveValidators([
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
        projectFilePatterns: ["src/**/*.ts"],
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
        "  Active: \"active\",",
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

    const validator = resolveValidators(
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
    writeFileSync(
      path.join(rootDir, "src/config.ts"),
      [
        "export const apiKey = \"not-a-real-secret-value\";",
        "export const placeholder = \"<generated-token>\";",
        "export const callbackUrl = \"https://api.example.com/callback\";",
        "export const safeName = \"company\";",
        "export const localPort = 4767;",
      ].join("\n"),
    );

    const secretValidator = resolveValidators(
      noSecretLikeLiterals({
        id: "no-secret-like-literals",
        topics: ["security"],
        severity: "error",
        in: ["src/**/*.ts"],
        message: "Secret-like literals must not be committed.",
      }),
    ).validators[0];
    const configValidator = resolveValidators(
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
      files: ["src/config.ts"],
      targetFiles: ["src/config.ts"],
      analysisFiles: ["src/config.ts"],
      validator: secretValidator,
    });

    const runtime = createRuntime(createPaths(rootDir), []);
    const secretFindings = await secretValidator.validate({ ctx, runtime });
    assert.equal(secretFindings.length, 1);
    assert.equal(secretFindings[0].severity, "error");
    assert.equal(secretFindings[0].line, 1);

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
          "failing-smoke": ["bun", "-e", "console.error('external failed'); process.exit(2);"],
        },
      }),
    );
    writeFileSync(path.join(rootDir, "apps/api/package.json"), JSON.stringify({ name: "@demo/api", dependencies: { "@demo/db": "workspace:*" } }));
    writeFileSync(path.join(rootDir, "apps/api/src/route.ts"), "import { internalTable } from '@demo/db/schema';\nexport const route = internalTable;\n");
    writeFileSync(path.join(rootDir, "packages/db/package.json"), JSON.stringify({ name: "@demo/db" }));
    writeFileSync(path.join(rootDir, "packages/db/src/schema.ts"), "export const internalTable = 'internal';\n");

    const resolved = resolveValidators([
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
    const validator = resolveValidators(
      externalCommand({
        id: "external-timeout",
        topics: ["doctor"],
        severity: "warning",
        command: "bun",
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
    const validator = resolveValidators(
      externalCommand({
        id: "external-cwd",
        topics: ["doctor"],
        severity: "warning",
        command: "bun",
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
        "const args = Bun.argv.slice(2);",
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
            command: ["bun", "tools/demo-lint.ts"],
            versionArgs: ["--version"],
            missingSeverity: "error",
          },
        },
      }),
    );

    const paths = createPaths(rootDir);
    const validator = resolveValidators(
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
      "if (Bun.argv.includes('--version')) { console.log('demo-lint 1.0.0'); process.exit(0); }\n",
    );
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "filesystem",
        projectFilePatterns: ["tools/**/*.ts"],
        ignore: [],
        externalTools: {
          "demo-lint": {
            command: ["bun", "tools/demo-lint.ts"],
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
    const skippedReport = buildDoctorReport({ paths, decisions: [], validators: [] });
    const skippedCheck = skippedReport.checks.find((item) => item.id === "external-tools");

    assert.equal(skippedCheck?.status, "warn");
    assert(skippedCheck?.message.includes("not executed"));

    const report = buildDoctorReport({ paths, decisions: [], validators: [], runExternalTools: true });
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
    const report = buildDoctorReport({ paths, decisions: [], validators: [] });
    const check = report.checks.find((item) => item.id === "project-discovery");

    assert.equal(check?.status, "fail");
    assert(check?.details?.some((detail) => detail.includes("fileDiscovery")));
    assert(check?.details?.some((detail) => detail.includes("maxFiles")));
    assert(check?.details?.some((detail) => detail.includes("maxFileSizeKb")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doctor treats missing config as built-in defaults", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-doctor-defaults-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), "{\"type\":\"module\",\"scripts\":{\"opencanon\":\"opencanon\"}}\n");

    const report = buildDoctorReport({ paths: createPaths(rootDir), decisions: [], validators: [] });
    const check = report.checks.find((item) => item.id === "config");

    assert.equal(check?.status, "pass");
    assert(check?.message.includes("built-in defaults"));
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
    const report = buildDoctorReport({ paths, decisions: [], validators: [] });
    const check = report.checks.find((item) => item.id === "cache-ignore");

    assert.equal(check?.status, "fail");
    assert(check?.details?.some((detail) => detail.includes(".opencanon/cache/")));

    const fix = applyDoctorFixes({ paths, report, mode: "safe", dryRun: false });
    assert.equal(fix.diagnostics.length, 0);
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/cache/"));

    const fixedReport = buildDoctorReport({ paths, decisions: [], validators: [] });
    assert.equal(fixedReport.checks.find((item) => item.id === "cache-ignore")?.status, "pass");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("context command lists decision exceptions", () => {
  const result = spawnSync("bun", [".agents/skills/opencanon/scripts/opencanon.ts", "context", "--list-exceptions", "--format", "json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { exceptions: Array<{ id: string; exceptions: string[] }> };
  assert(parsed.exceptions.some((decision) => decision.id === "const-object-enums" && decision.exceptions.length > 0));
});

test("fixture checks can be scoped to one validator", () => {
  const result = spawnSync("bun", [".agents/skills/opencanon/scripts/opencanon.ts", "validate", "--check-fixtures", "--validator", "no-native-enums"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert(result.stdout.includes("no-native-enums/valid"));
  assert(result.stdout.includes("no-native-enums/invalid"));
  assert(!result.stdout.includes("dal-transaction-param/valid"));
});

test("rules command renders validator summaries and fixture coverage", () => {
  const result = spawnSync("bun", [".agents/skills/opencanon/scripts/opencanon.ts", "rules", "--validator", "no-native-enums"], {
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

test("rules command filters validators by linked decision", () => {
  const result = spawnSync("bun", [".agents/skills/opencanon/scripts/opencanon.ts", "rules", "--decision", "const-object-enums"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert(result.stdout.includes("## no-native-enums [error]"));
  assert(result.stdout.includes("## repeated-domain-literals [warning]"));
  assert(!result.stdout.includes("## service-no-db-client"));
});

test("rules command renders tree visualizations", () => {
  const result = spawnSync("bun", [".agents/skills/opencanon/scripts/opencanon.ts", "rules", "--tree", "--validator", "no-dumpster-folders", "--ascii", "--no-color"], {
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
  const result = spawnSync("bun", [".agents/skills/opencanon/scripts/opencanon.ts", "rules", "--tree", "--validator", "service-no-db-client", "--ascii", "--no-color"], {
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
    mkdirSync(path.join(rootDir, "validators"), { recursive: true });
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        fileDiscovery: "filesystem",
        decisionsPath: "docs/opencanon/decisions.json",
        validatorsPath: "validators/index.ts",
        fixturesDir: "fixtures",
        projectFilePatterns: ["src/**/*.ts"],
        ignore: ["node_modules/**", ".git/**"],
        requiredPackageScripts: [],
      }),
    );
    writeFileSync(path.join(rootDir, "docs/opencanon/decisions.json"), "[]\n");
    writeFileSync(path.join(rootDir, "src/a.ts"), "const value = 'warn';\n");
    writeFileSync(
      path.join(rootDir, "validators/index.ts"),
      `export default {
  id: "warning-rule",
  topics: ["test"],
  severity: "warning",
  scope: "file",
  applies: ["src/**/*.ts"],
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
};
`,
    );

    const script = path.join(process.cwd(), ".agents/skills/opencanon/scripts/opencanon.ts");
    const normal = spawnSync("bun", [script, "validate", "--files", "src/a.ts"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(normal.status, 0, normal.stderr || normal.stdout);
    assert(normal.stdout.includes("Finding Resolution Policy"));
    assert(normal.stdout.includes("warning: non-blocking finding"));

    const strict = spawnSync("bun", [script, "validate", "--files", "src/a.ts", "--strict-warnings"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(strict.status, 1, strict.stderr || strict.stdout);
  } finally {
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
