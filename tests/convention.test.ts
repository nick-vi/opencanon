import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { BatchProducerPolicy, DefinitionTargetKind, ValidatorDomain, buildDoctorReport, createPaths, createRenderLinkContext, DoctorCheckGroup, DoctorStatus, loadProjectContext, resolveGoverningConventionsForFiles, resolveImpactSurfaceConventionsForFiles, resolveValidators, runValidation, validateContext } from "@opencanon/core";
import { defineArea, resolveAreas, type Area, type AreaRenderStyle } from "@opencanon/core/area";
import { renderArea } from "@opencanon/core/area-render";
import { defineSpec, type Spec, type SpecRenderStyle } from "@opencanon/core/spec";
import { renderSpec } from "@opencanon/core/spec-render";
import { defineChange, resolveChanges, type Change, type ChangeRenderStyle } from "@opencanon/core/change";
import { renderChange } from "@opencanon/core/change-render";
import { conventionToValidator, defineConvention, resolveConventions, type Convention, type RenderStyle } from "@opencanon/core/convention";
import { renderConvention } from "@opencanon/core/convention-render";
import {
  buildConventionDiffGitArgs,
  buildConventionHistoryGitArgs,
  buildRelatedCommitsGitArgs,
  ConventionGitLogFormat,
  loadAreaHistoryTarget,
  loadChangeHistoryTarget,
  loadSpecHistoryTarget,
  resolveConventionDefinitionFilesFromSources,
} from "../packages/core/src/convention-history.ts";

function docsOnly(id: string, extra: Partial<Convention> = {}): Convention {
  return defineConvention({ id, title: id, rule: "r", applies: { kind: "files", globs: ["**"] }, render: { kind: "none" }, runtime: { kind: "none" }, ...extra });
}

test("duplicate local id is an error", () => {
  const r = resolveConventions([docsOnly("dup"), docsOnly("dup")]);
  assert.equal(r.byId.size, 1);
  assert.match(r.diagnostics.join("\n"), /Duplicate local convention id: dup/);
});

test("conventionToValidator: docs-only (runtime none) does not execute", () => {
  assert.equal(conventionToValidator(docsOnly("d")), undefined);
});

test("conventionToValidator: validator runtime maps to executor shape", () => {
  const c = defineConvention({
    id: "no-x", title: "No X", rule: "no x",
    applies: { kind: "files", globs: ["src/**"] },
    render: { kind: "generated", docs: "docs/no-x.md", style: "reference" },
    runtime: { kind: "validator", severity: "error", scope: "file", facts: ["symbols"], validate: () => [] },
  });
  const v = conventionToValidator(c)!;
  assert.equal(v.id, "no-x");
  assert.deepEqual(v.applies, ["src/**"]);
  assert.equal(v.severity, "error");
  assert.equal(v.scope, "file");
  assert.deepEqual(v.facts, ["symbols"]);
  assert.deepEqual(v.docs, ["docs/no-x.md#no-x"]);
  assert.equal(typeof v.validate, "function");
});

test("conventionToValidator: gate maps to error severity + routes validate", () => {
  const c = defineConvention({
    id: "g", title: "G", rule: "gate",
    applies: { kind: "imports", from: ["**/*.service.ts"] },
    render: { kind: "none" },
    runtime: { kind: "gate", question: "ok?", scope: "project", facts: ["references"], validate: () => [] },
  });
  const v = conventionToValidator(c)!;
  assert.equal(v.severity, "error");
  assert.deepEqual(v.applies, ["**/*.service.ts"]);
  assert.equal(v.docs, undefined);
});

test("conventionToValidator: definition and project applies map to explicit domains", () => {
  const definitionConvention = defineConvention({
    id: "spec-governance",
    title: "Spec Governance",
    rule: "Specs declare checks.",
    applies: { kind: "definitions", definitions: [{ kind: "spec" }] },
    render: { kind: "none" },
    runtime: { kind: "validator", severity: "warning", scope: "project", facts: [], validate: () => [] },
  });
  const projectConvention = defineConvention({
    id: "project-governance",
    title: "Project Governance",
    rule: "The project has required metadata.",
    applies: { kind: "project", describe: "project metadata" },
    render: { kind: "none" },
    runtime: { kind: "validator", severity: "warning", scope: "project", facts: [], validate: () => [] },
  });

  const definitionValidator = conventionToValidator(definitionConvention)!;
  const projectValidator = conventionToValidator(projectConvention)!;

  assert.deepEqual(definitionValidator.applies, []);
  assert.equal(definitionValidator.domain, ValidatorDomain.Definition);
  assert.deepEqual(projectValidator.applies, []);
  assert.equal(projectValidator.domain, ValidatorDomain.Project);
});

test("definition-domain validators run for project and definition source validation only", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-definition-domain-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    mkdirSync(path.join(rootDir, "opencanon/specs"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ scripts: { opencanon: "opencanon" } }));
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", requiredPackageScripts: ["opencanon"] }));
    writeFileSync(path.join(rootDir, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(rootDir, "opencanon/specs/index.ts"), "export default [];\n");
    const paths = createPaths(rootDir);
    const convention = defineConvention({
      id: "spec-has-checks",
      title: "Spec Has Checks",
      rule: "Specs declare checks.",
      applies: { kind: "definitions", definitions: [{ kind: "spec" }] },
      render: { kind: "none" },
      runtime: {
        kind: "validator",
        severity: "warning",
        scope: "project",
        facts: [],
        validate({ ctx, runtime }) {
          return runtime.definitions.specs.flatMap((spec) =>
            spec.checkIds.length === 0 ? [ctx.report({ file: "opencanon/specs/index.ts", line: 1, message: `${spec.id} has no checks.` })] : [],
          );
        },
      },
    });
    const validatorDefinition = conventionToValidator(convention)!;
    const resolution = resolveValidators([validatorDefinition]);
    assert.deepEqual(resolution.diagnostics, []);
    const validator = resolution.validators[0]!;
    const spec = defineSpec({
      id: "unchecked-spec",
      title: "Unchecked Spec",
      summary: "Missing checks.",
      render: { kind: "none" },
    });

    const projectResult = await runValidation({ rootDir, paths, conventions: [convention], validators: [validator], specs: [spec], project: true, producerPolicy: BatchProducerPolicy });
    const sourceResult = await runValidation({ rootDir, paths, conventions: [convention], validators: [validator], specs: [spec], files: ["opencanon/specs/index.ts"], producerPolicy: BatchProducerPolicy });
    const unrelatedResult = await runValidation({ rootDir, paths, conventions: [convention], validators: [validator], specs: [spec], files: ["src/a.ts"], producerPolicy: BatchProducerPolicy });

    assert.equal(projectResult.findings.length, 1);
    assert.equal(sourceResult.findings.length, 1);
    assert.equal(unrelatedResult.findings.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("impact-surface backlinks are derived from convention declarations", () => {
  const surface = {
    id: "company-read-model",
    applies: ["src/db/dal/company.ts"],
    conventionIds: ["stale-surface-link"],
    proposed: true,
  };
  const conventions = [
    docsOnly("company-read-model-current", {
      title: "Company read model convention",
      rule: "Company read-model changes must preserve API and reporting behavior.",
      impactSurfaces: ["company-read-model"],
      render: { kind: "generated", docs: "docs/impact-company-read-model-current.md", style: "reference" },
    }),
    docsOnly("stale-surface-link"),
  ];

  const resolved = resolveImpactSurfaceConventionsForFiles({
    files: ["src/db/dal/company.ts"],
    impactSurfaces: [surface],
    conventions,
  });

  assert.deepEqual(resolved.surfaces.map((match) => match.surface.id), ["company-read-model"]);
  assert.deepEqual(resolved.surfaces[0]?.conventionIds, ["company-read-model-current"]);
  assert.deepEqual(resolved.conventions.map((convention) => convention.id), ["company-read-model-current"]);
});

test("governing convention resolution auto-loads applies and impact conventions with advisory fallback", () => {
  const conventions = [
    docsOnly("api-shape", {
      title: "API shape",
      rule: "API route changes keep response contracts stable.",
      applies: { kind: "files", globs: ["src/api/**"] },
      render: { kind: "generated", docs: "docs/api-shape.md", style: "reference" },
    }),
    docsOnly("company-impact", {
      title: "Company impact",
      rule: "Company read-model changes account for downstream reports.",
      impactSurfaces: ["company-read-model"],
    }),
  ];
  const impactSurfaces = [{ id: "company-read-model", applies: ["src/db/dal/company.ts"], conventionIds: ["company-impact"], proposed: true }];

  const resolved = resolveGoverningConventionsForFiles({
    files: ["src/api/routes/companies.ts", "src/db/dal/company.ts"],
    impactSurfaces,
    conventions,
  });

  assert.deepEqual(
    resolved.conventions.map((convention) => convention.id),
    ["api-shape", "company-impact"],
  );
  assert.deepEqual(resolved.conventions.find((convention) => convention.id === "api-shape")?.docs, ["docs/api-shape.md#api-shape"]);
  assert.deepEqual(resolved.conventions.find((convention) => convention.id === "company-impact")?.impactSurfaceIds, ["company-read-model"]);
  assert.equal(resolved.advisory, undefined);

  const capped = resolveGoverningConventionsForFiles({
    files: ["src/api/routes/companies.ts", "src/db/dal/company.ts"],
    impactSurfaces,
    conventions,
    maxConventions: 1,
  });
  assert.equal(capped.truncated, true);
  assert.equal(capped.omittedConventions, 1);

  const advisory = resolveGoverningConventionsForFiles({
    files: ["src/new/handler.ts", "docs/notes.md"],
    impactSurfaces: [],
    conventions: [],
  }).advisory;
  assert.equal(advisory?.title, "Missing convention?");
  assert.deepEqual(advisory?.files, ["src/new/handler.ts"]);
});

test("context validation reports impact-surface backlink inconsistencies", () => {
  const diagnostics = validateContext({
    conventions: [
      docsOnly("declared-surface", { impactSurfaces: ["company-read-model"] }),
      docsOnly("stale-surface-link"),
      docsOnly("missing-surface-link", { impactSurfaces: ["missing-surface"] }),
    ],
    impactSurfaces: [
      {
        id: "company-read-model",
        applies: ["src/db/dal/company.ts"],
        conventionIds: ["stale-surface-link"],
        proposed: true,
      },
    ],
  });

  assert(diagnostics.includes("Convention missing-surface-link references missing impact surface: missing-surface"));
  assert(diagnostics.includes("Impact surface company-read-model omits convention declared-surface, but convention declared-surface references impact surface company-read-model."));
  assert(diagnostics.includes("Impact surface company-read-model references convention stale-surface-link, but convention stale-surface-link does not reference impact surface company-read-model."));

  const files = resolveConventionDefinitionFilesFromSources({
    conventionId: "docs-only-rule",
    conventionsPath: "conventions/index.ts",
    sources: [
      { path: "conventions/index.ts", content: 'import docsOnlyRule from "./docs-only-rule.ts";\nexport default [docsOnlyRule];\n' },
      { path: "conventions/docs-only-rule.ts", content: 'import { defineConvention } from "@opencanon/core";\nexport default defineConvention({ id: "docs-only-rule" });\n' },
      { path: "conventions/related.ts", content: 'export const related = ["docs-only-rule"];\n' },
    ],
  });

  assert.deepEqual(files, ["conventions/docs-only-rule.ts"]);

  const historyFiles = ["conventions/docs-only-rule.ts", "docs/opencanon/canon/rules.md"];

  assert.deepEqual(buildConventionHistoryGitArgs(historyFiles), ["log", "--date=short", `--format=${ConventionGitLogFormat}`, "--", ...historyFiles]);
  assert.deepEqual(buildConventionDiffGitArgs({ from: "v1", to: "HEAD", files: historyFiles }), ["diff", "v1", "HEAD", "--", ...historyFiles]);
  assert.deepEqual(buildRelatedCommitsGitArgs({ id: "docs-only-rule", files: historyFiles }), {
    path: ["log", "--date=short", `--format=${ConventionGitLogFormat}`, "--", ...historyFiles],
    grep: ["log", "--all", "--fixed-strings", "--grep=docs-only-rule", "--date=short", `--format=${ConventionGitLogFormat}`],
  });
});

test("context validation rejects documented test-only conventions", () => {
  const diagnostics = validateContext({
    conventions: [
      defineConvention({
        id: "test-with-docs",
        title: "Test With Docs",
        rule: "Test runtime conventions are runtime-only.",
        applies: { kind: "files", globs: ["src/**/*.ts"] },
        render: { kind: "generated", docs: "docs/opencanon/canon/test-with-docs.md", style: "reference" },
        runtime: { kind: "test", severity: "warning", scope: "file", facts: [], validate: () => [] },
      }),
    ],
  });

  assert(diagnostics.includes('Convention test-with-docs runtime kind "test" must use render kind "none". Use runtime kind "validator" when the rule also has docs.'));
});

test("project context definition bundle loading is safe under concurrent reads", { timeout: 60000 }, async () => {
  const contexts = await Promise.all(Array.from({ length: 4 }, () => loadProjectContext(process.cwd())));
  assert(contexts.every((context) => context.areas.some((area) => area.id === "local-service-and-runtimes")));
  assert(contexts.every((context) => context.changes.some((change) => change.id === "area-change-model")));
  assert(contexts.every((context) => context.conventions.length > 0));
});

test("renderConvention snapshots every style deterministically", () => {
  const convention = defineConvention({
    id: "sample-rule",
    title: "Sample Rule",
    topics: ["sample"],
    why: "The sample rule keeps examples deterministic.",
    rule: "Sample files must use the approved shape.",
    examples: [{ good: "export const ok = true;", bad: "enum Bad { X }", note: "Keep examples short." }],
    related: ["other-rule"],
    impactSurfaces: ["sample-surface"],
    applies: { kind: "imports", from: ["src/**/*.ts"], to: ["src/db/**"] },
    render: { kind: "generated", docs: "docs/sample-rule.md", style: "reference" },
    runtime: {
      kind: "validator",
      severity: "warning",
      scope: "import-edge",
      facts: ["imports"],
      requiresProducers: ["typescript"],
      fixtures: "valid-and-invalid",
      validate: () => [],
    },
  });
  const linkContext = createRenderLinkContext({
    conventions: [
      convention,
      defineConvention({
        id: "other-rule",
        title: "Other Rule",
        rule: "Other rule.",
        applies: { kind: "files", globs: ["src/**/*.ts"] },
        render: { kind: "generated", docs: "docs/other-rule.md", style: "reference" },
        runtime: { kind: "none" },
      }),
    ],
    impactSurfaces: [
      {
        id: "sample-surface",
        title: "Sample Surface",
        applies: ["src/**"],
        docs: ["docs/surfaces.md#sample-surface"],
        conventionIds: ["sample-rule"],
      },
    ],
  });

  const snapshots = {
    narrative: `# Sample Rule

## Why

The sample rule keeps examples deterministic.

## Rule

The convention is: Sample files must use the approved shape.

## Applies to

This convention applies to:
- from \`src/**/*.ts\`
- to \`src/db/**\`

## Examples

Good:
\`\`\`
export const ok = true;
\`\`\`
Bad:
\`\`\`
enum Bad { X }
\`\`\`
- Keep examples short.

## Runtime checks

Runtime enforcement is configured as:
- Kind: \`validator\`
- Severity: \`warning\`
- Scope: \`import-edge\`
- Facts: \`imports\`
- Requires producers: \`typescript\`
- Fixtures: \`valid-and-invalid\`

## Related impact surfaces

Related impact surfaces:
- [Sample Surface](surfaces.md#sample-surface)

## Related conventions

Related conventions:
- [Other Rule](other-rule.md)
`,
    checklist: `# Sample Rule

## Rule

- [ ] Enforce: Sample files must use the approved shape.

## Applies to

- [ ] Check from \`src/**/*.ts\`
- [ ] Check to \`src/db/**\`

## Runtime checks

- [ ] Verify kind: \`validator\`
- [ ] Verify severity: \`warning\`
- [ ] Verify scope: \`import-edge\`
- [ ] Verify facts: \`imports\`
- [ ] Verify requires producers: \`typescript\`
- [ ] Verify fixtures: \`valid-and-invalid\`

## Examples

- [ ] Good:
\`\`\`
export const ok = true;
\`\`\`
- [ ] Bad:
\`\`\`
enum Bad { X }
\`\`\`
- [ ] Keep examples short.

## Why

- [ ] Confirm the rationale: The sample rule keeps examples deterministic.

## Related conventions

- [ ] Compare with [Other Rule](other-rule.md)

## Related impact surfaces

- [ ] Review impact surface [Sample Surface](surfaces.md#sample-surface)
`,
    reference: `# Sample Rule

## Rule

Sample files must use the approved shape.

## Applies to

- from \`src/**/*.ts\`
- to \`src/db/**\`

## Runtime checks

- Kind: \`validator\`
- Severity: \`warning\`
- Scope: \`import-edge\`
- Facts: \`imports\`
- Requires producers: \`typescript\`
- Fixtures: \`valid-and-invalid\`

## Why

The sample rule keeps examples deterministic.

## Examples

Good:
\`\`\`
export const ok = true;
\`\`\`
Bad:
\`\`\`
enum Bad { X }
\`\`\`
- Keep examples short.

## Related impact surfaces

- [Sample Surface](surfaces.md#sample-surface)

## Related conventions

- [Other Rule](other-rule.md)
`,
    "architecture-note": `# Sample Rule

## Why

The sample rule keeps examples deterministic.

## Applies to

Affected architecture scope:
- from \`src/**/*.ts\`
- to \`src/db/**\`

## Rule

Sample files must use the approved shape.

## Related impact surfaces

Architecture surfaces affected:
- [Sample Surface](surfaces.md#sample-surface)

## Runtime checks

Runtime guardrails:
- Kind: \`validator\`
- Severity: \`warning\`
- Scope: \`import-edge\`
- Facts: \`imports\`
- Requires producers: \`typescript\`
- Fixtures: \`valid-and-invalid\`

## Examples

Good:
\`\`\`
export const ok = true;
\`\`\`
Bad:
\`\`\`
enum Bad { X }
\`\`\`
- Keep examples short.

## Related conventions

Neighboring convention constraints:
- [Other Rule](other-rule.md)
`,
    "decision-record": `# Sample Rule

## Rule

Sample files must use the approved shape.

## Why

The sample rule keeps examples deterministic.

## Applies to

Scope of the decision:
- from \`src/**/*.ts\`
- to \`src/db/**\`

## Runtime checks

Enforcement recorded for this decision:
- Kind: \`validator\`
- Severity: \`warning\`
- Scope: \`import-edge\`
- Facts: \`imports\`
- Requires producers: \`typescript\`
- Fixtures: \`valid-and-invalid\`

## Related conventions

Related convention records:
- [Other Rule](other-rule.md)

## Related impact surfaces

Impact surfaces considered:
- [Sample Surface](surfaces.md#sample-surface)

## Examples

Good:
\`\`\`
export const ok = true;
\`\`\`
Bad:
\`\`\`
enum Bad { X }
\`\`\`
- Keep examples short.
`,
  } satisfies Record<string, string>;

  for (const [style, snapshot] of Object.entries(snapshots)) {
    assert.equal(renderConvention(convention, style as RenderStyle, linkContext), snapshot);
  }
});

test("doctor fails generated convention docs drift", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-convention-docs-"));
  try {
    mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ scripts: { opencanon: "opencanon" } }));
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", requiredPackageScripts: ["opencanon"] }));
    const paths = createPaths(rootDir);
    const convention = defineConvention({
      id: "generated-rule",
      title: "Generated Rule",
      why: "Generated docs are owned by OpenCanon.",
      rule: "The docs file must equal the rendered definition.",
      applies: { kind: "files", globs: ["src/**/*.ts"] },
      render: { kind: "generated", docs: "docs/generated-rule.md", style: "reference" },
      runtime: { kind: "none" },
    });

    writeFileSync(path.join(rootDir, "docs/generated-rule.md"), renderConvention(convention, "reference"));
    const passing = buildDoctorReport({ paths, conventions: [convention], validators: [] });
    assert.equal(passing.checks.find((check) => check.id === "convention-docs")?.status, DoctorStatus.Pass);
    assert.equal(passing.checks.find((check) => check.id === "convention-docs")?.group, DoctorCheckGroup.GeneratedState);

    writeFileSync(path.join(rootDir, "docs/generated-rule.md"), "hand edited\n");
    const failing = buildDoctorReport({ paths, conventions: [convention], validators: [] });
    const check = failing.checks.find((item) => item.id === "convention-docs");
    assert.equal(check?.status, DoctorStatus.Fail);
    assert.match(check?.details?.join("\n") ?? "", /generated-rule generated docs drifted/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function sampleArea(extra: Partial<Area> = {}): Area {
  return defineArea({
    id: "service-health",
    title: "Service Health",
    summary: "Users can inspect project health from the local service.",
    owns: [
      { kind: DefinitionTargetKind.File, path: "packages/runtime/src/service.ts" },
      { kind: DefinitionTargetKind.Endpoint, path: "/api/doctor", protocol: "http", adapter: "runtime" },
    ],
    stories: [
      {
        id: "health-without-cli",
        as: "developer",
        want: "to see project health",
        so: "I can recover quickly",
        acceptance: ["doctor status is visible"],
        checks: ["project-doctor"],
      },
    ],
    behaviors: [
      {
        id: "shows-doctor-status",
        actor: "developer",
        action: "opens Health",
        outcome: "doctor failures are visible",
        checks: ["project-doctor"],
      },
    ],
    checks: [{ id: "project-doctor", kind: "doctor" }],
    governedBy: { inferFromScope: true },
    render: { kind: "generated", docs: "docs/service-health.md", style: "reference" },
    ...extra,
  });
}

function sampleSpec(extra: Partial<Spec> = {}): Spec {
  return defineSpec({
    id: "service-health-spec",
    title: "Service Health Spec",
    summary: "Service health behavior stays visible and enforced.",
    scope: [{ kind: DefinitionTargetKind.File, path: "packages/runtime/src/service.ts" }],
    areas: ["service-health"],
    rules: [{ id: "shows-health", statement: "Service users can see project health.", acceptance: ["doctor status is visible"], checks: ["project-doctor"] }],
    scenarios: [
      {
        id: "inspect-health",
        given: ["a project runtime is running"],
        when: "the developer opens Health",
        then: ["doctor status is shown"],
        checks: ["project-doctor"],
      },
    ],
    checks: [{ id: "project-doctor", kind: "doctor" }],
    governedBy: { conventions: ["governance-rule"] },
    render: { kind: "generated", docs: "docs/service-health-spec.md", style: "reference" },
    ...extra,
  });
}

function sampleChange(extra: Partial<Change> = {}): Change {
  return defineChange({
    id: "service-health-change",
    title: "Service Health Change",
    kind: "feature",
    summary: "Expose service health as typed change.",
    updates: { areas: ["service-health"] },
    scope: [
      { kind: DefinitionTargetKind.File, path: "packages/runtime/src/service.ts" },
      { kind: DefinitionTargetKind.Doc, path: "docs/service-health-change.md" },
    ],
    intent: {
      problem: "Doctor is CLI-only.",
      outcome: "Health is visible through the local service.",
      why: "Service users need recovery context without switching tools.",
    },
    plan: [{ id: "api", title: "Expose doctor API", checks: ["project-doctor"] }],
    tasks: [{ id: "ui", title: "Wire health API", checks: ["service-build"] }],
    checks: [
      { id: "project-doctor", kind: "doctor" },
      { id: "service-build", kind: "command", command: "npm run check:types" },
    ],
    render: { kind: "generated", docs: "docs/service-health-change.md", style: "reference" },
    ...extra,
  });
}

test("renderSpec is deterministic", () => {
  const spec = sampleSpec();
  const linkContext = createRenderLinkContext({
    areas: [sampleArea()],
    conventions: [
      docsOnly("governance-rule", {
        title: "Governance Rule",
        render: { kind: "generated", docs: "docs/governance-rule.md", style: "reference" },
      }),
    ],
  });
  const expected = `# Service Health Spec

## Summary

Service health behavior stays visible and enforced.

## Scope

- Files: \`packages/runtime/src/service.ts\`

## Areas

- [Service Health](service-health.md)

## Checks

- \`project-doctor\` doctor

## Rules

Rule \`shows-health\`: Service users can see project health.
- doctor status is visible
Checks: \`project-doctor\`

## Scenarios

Scenario \`inspect-health\`
- Given a project runtime is running
- When the developer opens Health
- Then doctor status is shown
Checks: \`project-doctor\`

## Governance

- convention [Governance Rule](governance-rule.md)
`;

  assert.equal(renderSpec(spec, "reference" as SpecRenderStyle, linkContext), expected);
});

test("area definitions resolve duplicate ids", () => {
  const resolution = resolveAreas([sampleArea(), sampleArea({ title: "Duplicate Service Health" })]);
  assert.equal(resolution.byId.size, 1);
  assert.match(resolution.diagnostics.join("\n"), /Duplicate area id: service-health/);
});

test("renderArea is deterministic", () => {
  const area = sampleArea();
  const expected = `# Service Health

## Summary

Users can inspect project health from the local service.

## Ownership

Files: packages/runtime/src/service.ts
Endpoints: /api/doctor (runtime)

## Checks

- \`project-doctor\` doctor

## Stories

Story \`health-without-cli\`: as developer, I want to see project health, so I can recover quickly.
- doctor status is visible
Checks: \`project-doctor\`

## Behaviors

Behavior \`shows-doctor-status\`: developer opens Health; doctor failures are visible.
Checks: \`project-doctor\`

## Governance

- infer governing conventions from owned scope
`;

  assert.equal(renderArea(area, "reference" as AreaRenderStyle), expected);
});

test("context validation reports area link and check errors", () => {
  const diagnostics = validateContext({
    conventions: [docsOnly("governance-rule")],
    areas: [
      sampleArea({
        surfaces: ["missing-surface"],
        dependsOn: ["missing-area"],
        governedBy: { conventions: ["missing-convention"] },
        stories: [
          {
            id: "bad-story",
            as: "developer",
            want: "to inspect health",
            so: "I can recover",
            acceptance: ["doctor status is visible"],
            checks: ["missing-check"],
          },
        ],
      }),
    ],
    impactSurfaces: [],
  });

  assert(diagnostics.includes("Area service-health references missing impact surface: missing-surface"));
  assert(diagnostics.includes("Area service-health references missing dependency: missing-area"));
  assert(diagnostics.includes("Area service-health references missing governing convention: missing-convention"));
  assert(diagnostics.includes("Area service-health story bad-story references missing check: missing-check"));
});

test("context validation reports area dependency cycles", () => {
  const diagnostics = validateContext({
    conventions: [],
    areas: [
      sampleArea({ id: "alpha", title: "Alpha", dependsOn: ["beta"] }),
      sampleArea({ id: "beta", title: "Beta", dependsOn: ["alpha"] }),
    ],
  });

  assert(diagnostics.includes("Area dependency cycle detected: alpha -> beta -> alpha"));
});

test("context validation reports spec link and check errors", () => {
  const diagnostics = validateContext({
    conventions: [docsOnly("governance-rule")],
    areas: [sampleArea()],
    specs: [
      sampleSpec({
        surfaces: ["missing-surface"],
        areas: ["missing-area"],
        dependsOn: ["missing-spec"],
        governedBy: { conventions: ["missing-convention"] },
        rules: [{ id: "bad-rule", statement: "Bad rule.", checks: ["missing-check"] }],
      }),
    ],
    impactSurfaces: [],
  });

  assert(diagnostics.includes("Spec service-health-spec references missing impact surface: missing-surface"));
  assert(diagnostics.includes("Spec service-health-spec references missing area: missing-area"));
  assert(diagnostics.includes("Spec service-health-spec references missing dependency: missing-spec"));
  assert(diagnostics.includes("Spec service-health-spec references missing governing convention: missing-convention"));
  assert(diagnostics.includes("Spec service-health-spec rule bad-rule references missing check: missing-check"));
});

test("doctor fails generated spec docs drift", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-spec-docs-"));
  try {
    mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ scripts: { opencanon: "opencanon" } }));
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", requiredPackageScripts: ["opencanon"] }));
    const paths = createPaths(rootDir);
    const spec = sampleSpec();

    writeFileSync(path.join(rootDir, "docs/service-health-spec.md"), renderSpec(spec, "reference"));
    const passing = buildDoctorReport({ paths, specs: [spec], conventions: [docsOnly("governance-rule")], validators: [] });
    assert.equal(passing.checks.find((check) => check.id === "specs")?.status, DoctorStatus.Pass);

    writeFileSync(path.join(rootDir, "docs/service-health-spec.md"), "hand edited\n");
    const failing = buildDoctorReport({ paths, specs: [spec], conventions: [docsOnly("governance-rule")], validators: [] });
    const check = failing.checks.find((item) => item.id === "specs");
    assert.equal(check?.status, DoctorStatus.Fail);
    assert.match(check?.details?.join("\n") ?? "", /service-health-spec generated docs drifted/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doctor fails generated area docs drift", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-area-docs-"));
  try {
    mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ scripts: { opencanon: "opencanon" } }));
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", requiredPackageScripts: ["opencanon"] }));
    const paths = createPaths(rootDir);
    const area = sampleArea();

    writeFileSync(path.join(rootDir, "docs/service-health.md"), renderArea(area, "reference"));
    const passing = buildDoctorReport({ paths, areas: [area], conventions: [], validators: [] });
    assert.equal(passing.checks.find((check) => check.id === "areas")?.status, DoctorStatus.Pass);

    writeFileSync(path.join(rootDir, "docs/service-health.md"), "hand edited\n");
    const failing = buildDoctorReport({ paths, areas: [area], conventions: [], validators: [] });
    const check = failing.checks.find((item) => item.id === "areas");
    assert.equal(check?.status, DoctorStatus.Fail);
    assert.match(check?.details?.join("\n") ?? "", /service-health generated docs drifted/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("areas render command writes generated docs from definitions", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-area-render-"));
  try {
    mkdirSync(path.join(rootDir, "opencanon/areas"), { recursive: true });
    mkdirSync(path.join(rootDir, "opencanon/conventions"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ scripts: { opencanon: "opencanon" } }));
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", requiredPackageScripts: ["opencanon"] }));
    writeFileSync(path.join(rootDir, "opencanon/conventions/index.ts"), "export default [];\n");
    writeFileSync(
      path.join(rootDir, "opencanon/areas/index.ts"),
      `import { defineArea } from "@opencanon/core";

export default defineArea({
  id: "service-health",
  title: "Service Health",
  summary: "Health checks are visible in the local service.",
  render: { kind: "generated", docs: "docs/service-health.md", style: "reference" },
});
`,
    );

    const output = execFileSync(process.execPath, [path.join(process.cwd(), "packages/cli/src/index.ts"), "canon", "render", "areas", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    const result = JSON.parse(output) as { generated: number; changed: number; files: Array<{ id: string; action: string; path: string }> };

    assert.equal(result.generated, 1);
    assert.equal(result.changed, 1);
    assert.deepEqual(result.files.map((file) => [file.id, file.action, file.path]), [["service-health", "written", "docs/service-health.md"]]);
    assert.match(readFileSync(path.join(rootDir, "docs/service-health.md"), "utf8"), /^# Service Health\n/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doctor reports invalid Project Canon as JSON instead of crashing", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-doctor-invalid-canon-"));
  try {
    mkdirSync(path.join(rootDir, "opencanon/areas"), { recursive: true });
    mkdirSync(path.join(rootDir, "opencanon/conventions"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ scripts: { opencanon: "opencanon" } }));
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", requiredPackageScripts: ["opencanon"] }));
    writeFileSync(path.join(rootDir, "opencanon/conventions/index.ts"), "export default [];\n");
    writeFileSync(
      path.join(rootDir, "opencanon/areas/index.ts"),
      `import { defineArea } from "@opencanon/core";

export default defineArea({
  id: "service-health",
  title: "Service Health",
  summary: "Health checks are visible in the local service.",
  surfaces: ["missing-surface"],
  render: { kind: "none" },
});
`,
    );

    const result = spawnSync(process.execPath, [path.join(process.cwd(), "packages/cli/src/index.ts"), "doctor", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr, /Invalid OpenCanon context/);
    const report = JSON.parse(result.stdout) as { status: string; checks: Array<{ id: string; status: string; details?: string[] }> };
    assert.equal(report.status, "fail");
    const contextCheck = report.checks.find((check) => check.id === "context-files");
    assert.equal(contextCheck?.status, "fail");
    assert.match(contextCheck?.details?.join("\n") ?? "", /missing impact surface: missing-surface/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("areas draft command prints a TypeScript definition snippet", () => {
  const output = execFileSync(
    process.execPath,
    [
      path.join(process.cwd(), "packages/cli/src/index.ts"),
      "canon",
      "draft",
      "area",
      "service-search",
      "--title",
      "Service Search",
      "--summary",
      "Users can search project canon from the local service.",
      "--file",
      "packages/runtime/src/service.ts",
      "--surface",
      "service-runtime",
      "--check-command",
      "service-build=npm run check:types",
      "--docs",
      "docs/opencanon/areas/service-search.md",
      "--format",
      "json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  const result = JSON.parse(output) as { id: string; source: string; nextCommands: string[] };

  assert.equal(result.id, "service-search");
  assert(result.source.includes('import { defineArea } from "@opencanon/core";'));
  assert(result.source.includes('"id": "service-search"'));
  assert(result.source.includes('"command": "npm run check:types"'));
  assert.deepEqual(result.nextCommands, ["opencanon canon render areas", "opencanon doctor"]);
});

test("conventions draft command prints a TypeScript definition snippet", () => {
  const output = execFileSync(
    process.execPath,
    [
      path.join(process.cwd(), "packages/cli/src/index.ts"),
      "canon",
      "draft",
      "convention",
      "service-copy-language",
      "--title",
      "Service Copy Language",
      "--rule",
      "Service copy uses product-facing terms.",
      "--topic",
      "architecture",
      "--file",
      "packages/runtime/src/**/*.ts",
      "--docs",
      "docs/opencanon/canon/service-copy-language.md",
      "--runtime",
      "validator",
      "--facts",
      "literals,comments",
      "--format",
      "json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  const result = JSON.parse(output) as { id: string; source: string; nextCommands: string[] };

  assert.equal(result.id, "service-copy-language");
  assert(result.source.includes('import { defineConvention } from "@opencanon/core";'));
  assert(result.source.includes('id: "service-copy-language"'));
  assert(result.source.includes('render: { kind: "generated", docs: "docs/opencanon/canon/service-copy-language.md", style: "reference" }'));
  assert(result.source.includes('kind: "validator"'));
  assert(result.source.includes('facts: ["literals","comments"]'));
  assert.deepEqual(result.nextCommands, ["opencanon canon render conventions", "opencanon validate --check-fixtures", "opencanon doctor"]);
});

test("draft commands reject generated docs paths with heading anchors", () => {
  const cli = path.join(process.cwd(), "packages/cli/src/index.ts");
  const cases = [
    [
      "canon",
      "draft",
      "convention",
      "anchored-convention",
      "--title",
      "Anchored Convention",
      "--rule",
      "Generated docs use file paths.",
      "--docs",
      "docs/opencanon/canon/anchored-convention.md#heading",
    ],
    [
      "canon",
      "draft",
      "area",
      "anchored-area",
      "--title",
      "Anchored Area",
      "--summary",
      "Generated docs use file paths.",
      "--docs",
      "docs/opencanon/areas/anchored-area.md#heading",
    ],
    [
      "canon",
      "draft",
      "spec",
      "anchored-spec",
      "--title",
      "Anchored Spec",
      "--summary",
      "Generated docs use file paths.",
      "--docs",
      "docs/opencanon/specs/anchored-spec.md#heading",
    ],
    [
      "canon",
      "draft",
      "change",
      "anchored-change",
      "--title",
      "Anchored Change",
      "--problem",
      "Generated docs use file paths.",
      "--outcome",
      "Draft fails before emitting invalid source.",
      "--docs",
      "docs/opencanon/changes/anchored-change.md#heading",
    ],
  ];

  for (const args of cases) {
    let stderr = "";
    try {
      execFileSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      stderr = String((error as { stderr?: Buffer | string }).stderr ?? "");
    }
    assert.match(stderr, /--docs must be a generated Markdown file path, not a heading reference\./);
  }
});

test("change definitions resolve duplicate ids", () => {
  const resolution = resolveChanges([sampleChange(), sampleChange({ title: "Duplicate Service Health Change" })]);
  assert.equal(resolution.byId.size, 1);
  assert.match(resolution.diagnostics.join("\n"), /Duplicate change id: service-health-change/);
});

test("change render is deterministic", () => {
  const linkContext = createRenderLinkContext({ areas: [sampleArea()] });
  const expected = `# Service Health Change

Change kind: \`feature\`.

## Intent

Problem: Doctor is CLI-only.
Outcome: Health is visible through the local service.
Why: Service users need recovery context without switching tools.
Summary: Expose service health as typed change.

## Updates

- Areas: [Service Health](service-health.md)

## Scope

- Files: \`packages/runtime/src/service.ts\`
- Docs: \`docs/service-health-change.md\`

## Checks

- \`project-doctor\` doctor
- \`service-build\` command \`npm run check:types\`

## Plan

Plan \`api\`: Expose doctor API
Checks: \`project-doctor\`

## Tasks

Task \`ui\`: Wire health API
Checks: \`service-build\`
`;

  assert.equal(renderChange(sampleChange(), "reference" as ChangeRenderStyle, linkContext), expected);
});

test("context validation reports change link and check errors", () => {
  const diagnostics = validateContext({
    conventions: [docsOnly("known-convention")],
    areas: [sampleArea()],
    changes: [
      sampleChange({
        updates: {
          areas: ["missing-area"],
          conventions: ["missing-convention"],
          surfaces: ["missing-surface"],
        },
        dependsOn: ["missing-change"],
        blockedBy: ["missing-blocker"],
        plan: [{ id: "bad-plan", title: "Bad plan", checks: ["missing-check"] }],
        tasks: [
          {
            id: "bad-task",
            title: "Bad task",
            checks: ["missing-check"],
            surfaces: ["missing-task-surface"],
            updates: {
              areas: ["missing-task-area"],
              specs: ["missing-task-spec"],
              conventions: ["missing-task-convention"],
              surfaces: ["missing-task-update-surface"],
            },
          },
        ],
      }),
    ],
    impactSurfaces: [],
  });

  assert(diagnostics.includes("Change service-health-change references missing area: missing-area"));
  assert(diagnostics.includes("Change service-health-change references missing convention: missing-convention"));
  assert(diagnostics.includes("Change service-health-change references missing impact surface: missing-surface"));
  assert(diagnostics.includes("Change service-health-change references missing dependency: missing-change"));
  assert(diagnostics.includes("Change service-health-change references missing blocker: missing-blocker"));
  assert(diagnostics.includes("Change service-health-change plan bad-plan references missing check: missing-check"));
  assert(diagnostics.includes("Change service-health-change task bad-task references missing area: missing-task-area"));
  assert(diagnostics.includes("Change service-health-change task bad-task references missing spec: missing-task-spec"));
  assert(diagnostics.includes("Change service-health-change task bad-task references missing convention: missing-task-convention"));
  assert(diagnostics.includes("Change service-health-change task bad-task references missing impact surface: missing-task-surface"));
  assert(diagnostics.includes("Change service-health-change task bad-task references missing impact surface: missing-task-update-surface"));
  assert(diagnostics.includes("Change service-health-change task bad-task references missing check: missing-check"));
});

test("context validation reports change dependency cycles", () => {
  const diagnostics = validateContext({
    conventions: [],
    areas: [],
    changes: [
      sampleChange({ id: "alpha", title: "Alpha", updates: {}, dependsOn: ["beta"] }),
      sampleChange({ id: "beta", title: "Beta", updates: {}, dependsOn: ["alpha"] }),
    ],
  });

  assert(diagnostics.includes("Change dependency cycle detected: alpha -> beta -> alpha"));
});

test("doctor fails generated change docs drift", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-change-docs-"));
  try {
    mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ scripts: { opencanon: "opencanon" } }));
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", requiredPackageScripts: ["opencanon"] }));
    const paths = createPaths(rootDir);
    const change = sampleChange({ updates: {} });

    writeFileSync(path.join(rootDir, "docs/service-health-change.md"), renderChange(change, "reference"));
    const passing = buildDoctorReport({ paths, changes: [change], conventions: [], validators: [] });
    assert.equal(passing.checks.find((check) => check.id === "changes")?.status, DoctorStatus.Pass);

    writeFileSync(path.join(rootDir, "docs/service-health-change.md"), "hand edited\n");
    const failing = buildDoctorReport({ paths, changes: [change], conventions: [], validators: [] });
    const check = failing.checks.find((item) => item.id === "changes");
    assert.equal(check?.status, DoctorStatus.Fail);
    assert.match(check?.details?.join("\n") ?? "", /service-health-change generated docs drifted/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("canon render changes command writes generated docs from definitions", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-change-render-"));
  try {
    mkdirSync(path.join(rootDir, "opencanon/conventions"), { recursive: true });
    mkdirSync(path.join(rootDir, "opencanon/changes"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ scripts: { opencanon: "opencanon" } }));
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", requiredPackageScripts: ["opencanon"] }));
    writeFileSync(path.join(rootDir, "opencanon/conventions/index.ts"), "export default [];\n");
    writeFileSync(
      path.join(rootDir, "opencanon/changes/index.ts"),
      `import { defineChange } from "@opencanon/core";

export default defineChange({
  id: "service-health-change",
  title: "Service Health Change",
  kind: "feature",
  intent: {
    problem: "Doctor is CLI-only.",
    outcome: "Health is visible through the local service.",
  },
  render: { kind: "generated", docs: "docs/service-health-change.md", style: "reference" },
});
`,
    );

    const output = execFileSync(process.execPath, [path.join(process.cwd(), "packages/cli/src/index.ts"), "canon", "render", "changes", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    const result = JSON.parse(output) as { generated: number; changed: number; files: Array<{ id: string; action: string; path: string }> };

    assert.equal(result.generated, 1);
    assert.equal(result.changed, 1);
    assert.deepEqual(result.files.map((file) => [file.id, file.action, file.path]), [["service-health-change", "written", "docs/service-health-change.md"]]);
    assert.match(readFileSync(path.join(rootDir, "docs/service-health-change.md"), "utf8"), /^# Service Health Change\n/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("canon draft change command prints a TypeScript definition snippet", () => {
  const output = execFileSync(
    process.execPath,
    [
      path.join(process.cwd(), "packages/cli/src/index.ts"),
      "canon",
      "draft",
      "change",
      "service-search-change",
      "--title",
      "Service Search Change",
      "--problem",
      "Search is not visible.",
      "--outcome",
      "Service users can search canon.",
      "--file",
      "packages/runtime/src/service.ts",
      "--area",
      "service-search",
      "--check-command",
      "service-build=npm run check:types",
      "--docs",
      "docs/opencanon/changes/service-search-change.md",
      "--format",
      "json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  const result = JSON.parse(output) as { id: string; source: string; nextCommands: string[] };

  assert.equal(result.id, "service-search-change");
  assert(result.source.includes('import { defineChange } from "@opencanon/core";'));
  assert(result.source.includes('"id": "service-search-change"'));
  assert(result.source.includes('"problem": "Search is not visible."'));
  assert(result.source.includes('"areas"'));
  assert.deepEqual(result.nextCommands, ["opencanon canon render changes", "opencanon doctor"]);
});

test("canon draft impact-surface writes a validated proposed surface", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-impact-surface-draft-"));
  const cli = path.join(process.cwd(), "packages/cli/src/index.ts");
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    execFileSync(process.execPath, [cli, "init", "--yes", "--no-runtime", "--file-discovery", "filesystem"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    const output = execFileSync(
      process.execPath,
      [
        cli,
        "canon",
        "draft",
        "impact-surface",
        "ui-shell",
        "--title",
        "UI Shell",
        "--applies",
        "src/**/*.{ts,tsx},tests/**/*.ts",
        "--owns",
        "area:service",
        "--risk",
        "Layout regressions",
        "--format",
        "json",
      ],
      { cwd: rootDir, encoding: "utf8" },
    );
    const payload = JSON.parse(output) as { id: string; path: string; surface: { id: string; applies: string[]; proposed?: boolean } };
    const surfaces = JSON.parse(readFileSync(path.join(rootDir, "docs/opencanon/impact-surfaces.json"), "utf8")) as Array<{ id: string; applies: string[]; proposed?: boolean }>;

    assert.equal(payload.id, "ui-shell");
    assert.equal(payload.path, "docs/opencanon/impact-surfaces.json");
    assert.deepEqual(payload.surface.applies, ["src/**/*.{ts,tsx}", "tests/**/*.ts"]);
    assert.equal(payload.surface.proposed, true);
    assert.equal(surfaces[0]?.id, "ui-shell");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("canon draft impact-surface can repair a project that already references the missing surface", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-impact-surface-repair-"));
  const cli = path.join(process.cwd(), "packages/cli/src/index.ts");
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    execFileSync(process.execPath, [cli, "init", "--yes", "--no-runtime", "--file-discovery", "filesystem"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    writeFileSync(
      path.join(rootDir, "opencanon/areas/index.ts"),
      `import { defineArea } from "@opencanon/core";

export default defineArea({
  id: "todo-domain",
  title: "Todo Domain",
  summary: "Todo behavior lives here.",
  surfaces: ["todo-domain"],
  render: { kind: "none" },
});
`,
    );

    await assert.rejects(() => loadProjectContext(rootDir), /missing impact surface: todo-domain/);

    const output = execFileSync(
      process.execPath,
      [
        cli,
        "canon",
        "draft",
        "impact-surface",
        "todo-domain",
        "--title",
        "Todo Domain",
        "--applies",
        "src/**/*.ts",
        "--format",
        "json",
      ],
      { cwd: rootDir, encoding: "utf8" },
    );
    const payload = JSON.parse(output) as { id: string; surface: { id: string } };
    assert.equal(payload.id, "todo-domain");
    assert.equal(payload.surface.id, "todo-domain");

    const project = await loadProjectContext(rootDir);
    assert.equal(project.impactSurfaces[0]?.id, "todo-domain");

    const listOutput = execFileSync(process.execPath, [cli, "canon", "list", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    const listPayload = JSON.parse(listOutput) as { areas: Array<{ id: string; title: string }> };
    assert.deepEqual(listPayload.areas, [{ id: "todo-domain", title: "Todo Domain" }]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("specs draft command prints a TypeScript definition snippet", () => {
  const output = execFileSync(
    process.execPath,
    [
      path.join(process.cwd(), "packages/cli/src/index.ts"),
      "canon",
      "draft",
      "spec",
      "service-health-spec",
      "--title",
      "Service Health Spec",
      "--summary",
      "Health stays visible.",
      "--file",
      "packages/runtime/src/service.ts",
      "--area",
      "service-health",
      "--convention",
      "tests-follow-risk",
      "--rule",
      "shows-health=Service users can inspect health.",
      "--check-command",
      "service-build=npm run check:types",
      "--docs",
      "docs/opencanon/specs/service-health-spec.md",
      "--format",
      "json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  const result = JSON.parse(output) as { id: string; source: string; nextCommands: string[] };

  assert.equal(result.id, "service-health-spec");
  assert(result.source.includes('import { defineSpec } from "@opencanon/core";'));
  assert(result.source.includes('"id": "service-health-spec"'));
  assert(result.source.includes('"areas"'));
  assert(result.source.includes('"governedBy"'));
  assert(result.source.includes('"rules"'));
  assert.deepEqual(result.nextCommands, ["opencanon canon render specs", "opencanon doctor"]);
});

test("area, spec, and change history targets include definition and doc files", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-definition-history-"));
  try {
    mkdirSync(path.join(rootDir, "opencanon/conventions"), { recursive: true });
    mkdirSync(path.join(rootDir, "opencanon/areas"), { recursive: true });
    mkdirSync(path.join(rootDir, "opencanon/specs"), { recursive: true });
    mkdirSync(path.join(rootDir, "opencanon/changes"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ scripts: { opencanon: "opencanon" } }));
    writeFileSync(path.join(rootDir, "opencanon.config.json"), JSON.stringify({ fileDiscovery: "filesystem", requiredPackageScripts: ["opencanon"] }));
    writeFileSync(path.join(rootDir, "opencanon/conventions/index.ts"), "export default [];\n");
    writeFileSync(path.join(rootDir, "opencanon/areas/index.ts"), 'import serviceHealth from "./service-health.ts";\nexport default [serviceHealth];\n');
    writeFileSync(
      path.join(rootDir, "opencanon/areas/service-health.ts"),
      `import { defineArea } from "@opencanon/core";

export default defineArea({
  id: "service-health",
  title: "Service Health",
  summary: "Health checks are visible in the local service.",
  render: { kind: "generated", docs: "docs/service-health.md", style: "reference" },
});
`,
    );
    writeFileSync(path.join(rootDir, "opencanon/specs/index.ts"), 'import serviceHealthSpec from "./service-health-spec.ts";\nexport default [serviceHealthSpec];\n');
    writeFileSync(
      path.join(rootDir, "opencanon/specs/service-health-spec.ts"),
      `import { defineSpec } from "@opencanon/core";

export default defineSpec({
  id: "service-health-spec",
  title: "Service Health Spec",
  summary: "Health checks are visible in the local service.",
  render: { kind: "generated", docs: "docs/service-health-spec.md", style: "reference" },
});
`,
    );
    writeFileSync(path.join(rootDir, "opencanon/changes/index.ts"), 'import serviceHealthChange from "./service-health-change.ts";\nexport default [serviceHealthChange];\n');
    writeFileSync(
      path.join(rootDir, "opencanon/changes/service-health-change.ts"),
      `import { defineChange } from "@opencanon/core";

export default defineChange({
  id: "service-health-change",
  title: "Service Health Change",
  kind: "feature",
  intent: {
    problem: "Doctor is CLI-only.",
    outcome: "Health is visible through the local service.",
  },
  render: { kind: "generated", docs: "docs/service-health-change.md", style: "reference" },
});
`,
    );

    const area = await loadAreaHistoryTarget(rootDir, "service-health");
    const spec = await loadSpecHistoryTarget(rootDir, "service-health-spec");
    const change = await loadChangeHistoryTarget(rootDir, "service-health-change");

    assert.equal(area.ok, true);
    assert.equal(spec.ok, true);
    assert.equal(change.ok, true);
    if (area.ok) {
      assert.deepEqual(area.target.definitionFiles, ["opencanon/areas/service-health.ts"]);
      assert.deepEqual(area.target.docFiles, ["docs/service-health.md"]);
      assert.deepEqual(area.target.files, ["opencanon/areas/service-health.ts", "docs/service-health.md"]);
    }
    if (spec.ok) {
      assert.deepEqual(spec.target.definitionFiles, ["opencanon/specs/service-health-spec.ts"]);
      assert.deepEqual(spec.target.docFiles, ["docs/service-health-spec.md"]);
      assert.deepEqual(spec.target.files, ["opencanon/specs/service-health-spec.ts", "docs/service-health-spec.md"]);
    }
    if (change.ok) {
      assert.deepEqual(change.target.definitionFiles, ["opencanon/changes/service-health-change.ts"]);
      assert.deepEqual(change.target.docFiles, ["docs/service-health-change.md"]);
      assert.deepEqual(change.target.files, ["opencanon/changes/service-health-change.ts", "docs/service-health-change.md"]);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
