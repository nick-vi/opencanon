import { ConventionDefinitionKind, ValidatorDomain, defineConvention } from "@opencanon/core";

const specDefinitionsAreEnforced = defineConvention({
  id: "spec-definitions-are-enforced",
  title: "Specs declare enforcement and governance",
  topics: ["specs", "architecture", "testing"],
  related: ["state-ownership-current", "tests-follow-risk"],
  impactSurfaces: ["project-canon-model"],
  why: "Specs are useful only when they stay connected to the implementation and the conventions that constrain it.",
  rule: "Specs should declare checks, governing conventions, and either implementation scope or impact surfaces.",
  applies: { kind: "definitions", definitions: [{ kind: ConventionDefinitionKind.Spec }] },
  render: { kind: "generated", docs: "docs/opencanon/canon/spec-definitions-are-enforced.md", style: "reference" },
  runtime: {
    kind: "validator",
    severity: "warning",
    scope: "project",
    domain: ValidatorDomain.Definition,
    facts: [],
    fixtures: "valid-only",
    validate({ ctx, runtime }) {
      const findings = [];
      for (const spec of runtime.definitions.specs) {
        const source = spec.source?.split("#", 1)[0] ?? "opencanon/specs/index.ts";
        if (spec.checkIds.length === 0) {
          findings.push(ctx.report({ file: source, line: 1, message: `Spec ${spec.id} should declare at least one check.` }));
        }
        if (spec.conventionIds.length === 0) {
          findings.push(ctx.report({ file: source, line: 1, message: `Spec ${spec.id} should link at least one governing convention.` }));
        }
        if (spec.targetFiles.length === 0 && spec.surfaces.length === 0) {
          findings.push(ctx.report({ file: source, line: 1, message: `Spec ${spec.id} should declare implementation scope or impact surfaces.` }));
        }
      }
      return findings;
    },
  },
});

export default specDefinitionsAreEnforced;
