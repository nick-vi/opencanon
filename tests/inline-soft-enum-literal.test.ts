import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import {
  comparisonSites,
  createPaths,
  conventionToValidator,
  ProducerStatusKind,
  createRuntime,
  createValidationContext,
  prewarmContextTypeFacts,
  siteKey,
  type TypeFactsProvider,
  type TypeResolution,
} from "@opencanon/core";
import inlineSoftEnumLiteral from "../opencanon/conventions/inline-soft-enum-literal.ts";

const inlineSoftEnumLiteralValidator = conventionToValidator(inlineSoftEnumLiteral);

/**
 * The fixture harness can't give ephemeral files real (checked) types, so the
 * checked-type paths of `inline-soft-enum-literal` are proven here by injecting a
 * `TypeFactsProvider` through the `prewarmContextTypeFacts` providerOverride seam.
 */

const CompanyStatusUnion: TypeResolution = {
  kind: "literal-union",
  language: "typescript",
  display: "CompanyStatus",
  typeSource: "declared",
  members: [
    { value: { kind: "string", value: "active" }, display: '"active"' },
    { value: { kind: "string", value: "archived" }, display: '"archived"' },
  ],
  syntax: "ts-const-object",
};

/**
 * Provider that returns `resolution` for every comparison site when `ready`. A
 * non-finite type is modeled as a ready producer that resolves nothing
 * (`resolution: undefined`) — binary, no `other` object reaches the rule.
 */
function providerFor(resolution: TypeResolution | undefined, kind: "ready" | "stale" = "ready"): TypeFactsProvider {
  return {
    language: "typescript",
    status() {
      return { language: "typescript", kind };
    },
    factGeneration() {
      return undefined;
    },
    async resolveTypes(sites) {
      const map = new Map<string, TypeResolution>();
      if (kind === ProducerStatusKind.Ready && resolution) for (const s of sites) map.set(siteKey(s.file, s.line, s.column), resolution);
      return map;
    },
  };
}

function buildContext(source: string) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "inline-soft-enum-"));
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  writeFileSync(path.join(rootDir, "src/status.ts"), source);
  const ctx = createValidationContext({
    rootDir,
    paths: createPaths(rootDir),
    files: ["src/status.ts"],
    targetFiles: ["src/status.ts"],
    analysisFiles: ["src/status.ts"],
    cache: null,
    validator: { id: "inline-soft-enum-literal", severity: "warning" },
  });
  return { rootDir, ctx };
}

// A const-object declaration (gives "active"/"archived" a declarationSourceId) plus
// a comparison site inlining one of those values.
const SourceWithDeclaredEnum = [
  'export const CompanyStatus = {',
  '  ACTIVE: "active",',
  '  ARCHIVED: "archived",',
  '} as const;',
  'export function isActive(status: CompanyStatus): boolean {',
  '  return status === "active";',
  '}',
].join("\n");

async function runWith(source: string, resolution: TypeResolution | undefined) {
  const { rootDir, ctx } = buildContext(source);
  try {
    await prewarmContextTypeFacts(ctx, rootDir, providerFor(resolution));
    assert.ok(inlineSoftEnumLiteralValidator?.validate, "convention defines validator runtime");
    return await inlineSoftEnumLiteralValidator.validate({ ctx, runtime: createRuntime(createPaths(rootDir), []) });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

describe("inline-soft-enum-literal (typed)", () => {
  it("flags an inline member when surroundingType is a checked finite set with a declared source", async () => {
    const findings = await runWith(SourceWithDeclaredEnum, CompanyStatusUnion);
    assert.equal(findings.length, 1);
    const finding = findings[0]!;
    assert.equal(finding.line, 6);
    assert.match(finding.message, /inline literal "active"/);
    assert.match(finding.message, /declared CompanyStatus member/);
    assert.equal(finding.severity, "warning");
  });

  it("does NOT flag when a ready producer resolves no finite-set type for the site", async () => {
    const findings = await runWith(SourceWithDeclaredEnum, undefined);
    assert.equal(findings.length, 0);
  });

  it("does NOT flag a non-member literal even when the type is a checked finite set", async () => {
    const nonMember = SourceWithDeclaredEnum.replace('status === "active"', 'status === "deleted"');
    const findings = await runWith(nonMember, CompanyStatusUnion);
    assert.equal(findings.length, 0);
  });

  it("does NOT flag a checked member with no declared named source in the project", async () => {
    // No const-object/union declaration -> "active" has no declarationSourceId anywhere.
    const noDecl = [
      'export function isActive(status: CompanyStatus): boolean {',
      '  return status === "active";',
      '}',
    ].join("\n");
    const findings = await runWith(noDecl, CompanyStatusUnion);
    assert.equal(findings.length, 0);
  });

  it("emits nothing when there is no resolved surrounding type at all", async () => {
    const findings = await runWith(SourceWithDeclaredEnum, undefined);
    assert.equal(findings.length, 0);
  });
});

// Sanity: comparisonSites picks up the inlined comparison literal (the pre-warm input).
describe("comparisonSites pre-warm input", () => {
  it("includes the inline comparison literal", () => {
    const { rootDir, ctx } = buildContext(SourceWithDeclaredEnum);
    try {
      const sites = comparisonSites(ctx.facts.literals());
      assert.ok(sites.some((s) => s.file === "src/status.ts" && s.line === 6));
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
