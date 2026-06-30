import { createConventionFactory } from "@opencanon/core";
import { ChangePolicyRequirement, joinPatterns, literalIgnored, manualFix, optionSummary } from "../shared.ts";
import type { DuplicateBoundaryLiteralsOptions, SensitiveChangePolicyOptions } from "../shared.ts";

export const duplicateBoundaryLiterals = createConventionFactory<DuplicateBoundaryLiteralsOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "project",
  facts: ["duplicates"],
  conventionIds: options.related,
  summary: optionSummary(options, `Boundary literals in ${joinPatterns(options.in)} should be canonicalized.`),
  validate({ ctx }) {
    const minOccurrences = options.minOccurrences ?? 3;
    const minFiles = options.minFiles ?? 1;
    return ctx.facts
      .duplicates()
      .filter((duplicate) => duplicate.kind === "literal")
      .filter((duplicate) => duplicate.occurrences >= minOccurrences)
      .filter((duplicate) => duplicate.files.length >= minFiles)
      .filter((duplicate) => !literalIgnored(duplicate.value, options.ignore ?? []))
      .map((duplicate) =>
        duplicate.file.report({
          line: duplicate.line,
          column: duplicate.column,
          message: `${options.message} Literal ${JSON.stringify(duplicate.value)} appears ${duplicate.occurrences} times across ${duplicate.files.length} file(s).`,
          fix: options.fix ?? manualFix("Move this boundary value into a named contract, constant, or schema owner."),
          docs: options.docs,
        }),
      );
  },
}));

export const sensitiveChangePolicy = createConventionFactory<SensitiveChangePolicyOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "project",
  conventionIds: options.related,
  summary: optionSummary(options, "Sensitive impact surfaces require the configured change policy."),
  validate({ ctx }) {
    if (ctx.project) return [];
    const checks = ctx.impact.requiredChecks(ctx.targetFiles);
    const require = options.require ?? "approval";
    return checks.flatMap((check) => {
      const first = check.files[0] ?? ctx.targetFiles.find((file) => check.surface.applies.some((pattern) => file.matches(pattern)));
      if (!first) return [];
      if (require === ChangePolicyRequirement.Tests && check.requiresTests.length === 0) return [];
      if (require === ChangePolicyRequirement.Docs && check.requiresDocs.length === 0) return [];
      if (require === ChangePolicyRequirement.Approval && !check.requiresApproval) return [];
      return [
        first.report({
          line: 1,
          message: `${options.message} Impact surface ${check.surface.id} requires ${require}.`,
          fix: options.fix ?? manualFix("Update the change with the required impact-surface evidence before merging."),
          docs: options.docs ?? check.surface.docs,
          conventionIds: check.surface.conventionIds,
        }),
      ];
    });
  },
}));
