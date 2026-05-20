import { createValidatorFactory } from "@opencanon/core";
import { manualFix, optionSummary } from "../shared.ts";
import type { MigrationReferencesOptions } from "../shared.ts";

export const migrationReferences = createValidatorFactory<MigrationReferencesOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.newSeverity ?? options.severity,
  scope: "file",
  decisionIds: options.decisionIds,
  summary: optionSummary(options, `Files matching ${options.in.join(", ")} must not introduce the migrated reference pattern.`),
  validate({ ctx }) {
    const pattern = typeof options.pattern === "string" ? new RegExp(options.pattern, "g") : options.pattern;
    return ctx.targetFiles.flatMap((file) =>
      file.find(pattern).map((match) => {
        const finding = file.report({
          line: match.line,
          column: match.column,
          message: options.message,
          fix: options.fix ?? manualFix("Use the replacement pattern documented by this migration rule."),
          docs: options.docs,
        });
        finding.severity = ctx.baseline.isKnown(finding) ? (options.existingSeverity ?? "warning") : (options.newSeverity ?? options.severity);
        return finding;
      }),
    );
  },
}));
