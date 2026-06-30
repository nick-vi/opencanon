import { asFiniteLiteralSet, defineConvention, finiteLiteralIncludes } from "@opencanon/core";

/**
 * inline-soft-enum-literal (TYPED) — soft-enum precision rule.
 *
 * Flags a string literal at a comparison site (`x === "foo"`) when the literal
 * is a member of a CHECKED finite literal set AND a named constant for that
 * value is declared somewhere in the project. Such a comparison should reference
 * the declared member instead of inlining the raw string.
 *
 * This rule consumes surrounding-type information ONLY through the area
 * accessors (`asFiniteLiteralSet` / `finiteLiteralIncludes`) — it never switches
 * on the resolution's hidden `kind`. It declares `requiresProducers:["typescript"]`,
 * so it runs only when the TypeScript producer is `ready`; otherwise the run skips
 * it with a diagnostic. A `surroundingType` is therefore always producer-checked.
 *
 * TESTING NOTE: the standard `validate --check-fixtures` harness materializes
 * ephemeral files that have NO ready producer, so it cannot exercise a finding.
 * The positive (flag) and conservatism (no-false-positive) assertions are
 * covered by a unit test that injects a `ready` `TypeFactsProvider` through the
 * `prewarmContextTypeFacts` providerOverride seam
 * (tests/inline-soft-enum-literal.test.ts). The `valid.ts` fixture only proves
 * the honest negative: with no resolved types, the rule emits nothing.
 */
const docs = ["docs/opencanon/canon/inline-soft-enum-literal.md#soft-enum-comparisons-use-declared-members"];

const convention = defineConvention({
  id: "inline-soft-enum-literal",
  title: "Soft enum comparisons use declared members",
  topics: ["type-patterns"],
  related: ["inline-soft-enum-literal"],
  rule: "Comparisons against a checked finite-literal set should reference the declared member, not inline the raw string.",
  applies: { kind: "files", globs: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"] },
  render: { kind: "generated", docs: "docs/opencanon/canon/inline-soft-enum-literal.md", style: "reference" },
  runtime: {
    kind: "validator",
    severity: "warning",
    scope: "file",
    facts: ["literals"],
    requiresProducers: ["typescript"],
    fixtures: "valid-only",
    validate({ ctx }) {
      // Map every value that HAS a declared named source (const-object member or
      // type-union arm) to that source id. A comparison-site literal never carries
      // `declarationSourceId` itself, so "is there a named constant for this value?"
      // is answered from the declaration-bearing literals across the project.
      const declaredSourceByValue = new Map<string, string>();
      for (const literal of ctx.facts.literals()) {
        if (literal.valueKind !== "string" || !literal.declarationSourceId) continue;
        if (!declaredSourceByValue.has(literal.value)) declaredSourceByValue.set(literal.value, literal.declarationSourceId);
      }

      const findings = [];
      // surroundingType is present only when the (ready) TypeScript producer resolved
      // the site to a finite literal set; a non-finite type is simply absent.
      for (const literal of ctx.typed.literal({ contexts: ["comparison"], valueKind: "string" })) {
        const resolution = literal.surroundingType;
        // 1. surroundingType is a finite literal set.
        if (!asFiniteLiteralSet(resolution)) continue;
        // 2. the literal is a member of that set.
        if (!finiteLiteralIncludes(resolution, literal.value)) continue;
        // 3. a declared named source exists for this value.
        const sourceId = declaredSourceByValue.get(literal.value);
        if (!sourceId) continue;

        const file = ctx.file(literal.file.path);
        if (!file) continue;
        // Precision guard: `typeof x === "string"` compares a runtime type tag, not a
        // soft-enum member, even when the surrounding union happens to contain that
        // tag string. The literal sits to the right of `typeof <expr> ===` on its line.
        const lineText = file.lineAt(literal.line);
        const beforeLiteral = lineText.slice(0, literal.column - 1);
        if (/\btypeof\b[^=]*[=!]==?\s*["'`]?$/.test(beforeLiteral)) continue;
        findings.push(
          file.report({
            line: literal.line,
            column: literal.column,
            message: `inline literal "${literal.value}" — compare against the declared ${sourceId} member instead.`,
            docs,
            fix: {
              safety: "manual",
              description: `Replace the inline "${literal.value}" with the ${sourceId} member reference.`,
            },
          }),
        );
      }
      return findings;
    },
  },
});

export default convention;
