import { createConventionFactory } from "@opencanon/core";
import { manualFix, optionSummary } from "../shared.ts";
import type { MigrationReferencesOptions } from "../shared.ts";

export const migrationReferences = createConventionFactory<MigrationReferencesOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.newSeverity ?? options.severity,
  scope: "file",
  conventionIds: options.related,
  summary: optionSummary(options, `Files matching ${options.in.join(", ")} must not introduce the migrated reference pattern.`),
  validate({ ctx }) {
    const pattern = typeof options.pattern === "string" ? new RegExp(options.pattern, "g") : options.pattern;
    return ctx.targetFiles.flatMap((file) =>
      file.find(pattern).map((match) => {
        const finding = file.report({
          line: match.line,
          column: match.column,
          message: options.message,
          fix: options.fix ?? migrationFix(file.path, match.line, match.column, match.text, options),
          docs: options.docs,
        });
        finding.severity = ctx.baseline.isKnown(finding) ? (options.existingSeverity ?? "warning") : (options.newSeverity ?? options.severity);
        return finding;
      }),
    );
  },
}));

function migrationFix(file: string, line: number, column: number, text: string, options: MigrationReferencesOptions) {
  if (!options.replacement) return manualFix("Use the replacement pattern documented by this migration rule.");
  return {
    safety: options.fixSafety ?? "suggested",
    description: "Replace this migrated reference with the configured current pattern.",
    edits: [
      {
        file,
        range: {
          startLine: line,
          startColumn: column,
          endLine: line,
          endColumn: column + text.length,
        },
        replacement: options.replacement,
      },
    ],
  };
}
