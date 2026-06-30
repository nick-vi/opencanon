import { createConventionFactory, ProjectFileLanguage } from "@opencanon/core";
import { joinPatterns, manualFix, optionSummary } from "../shared.ts";
import type { NoBareExceptOptions } from "../shared.ts";

export const noBareExcept = createConventionFactory<NoBareExceptOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "file",
  conventionIds: options.related,
  summary: optionSummary(options, `Python files matching ${joinPatterns(options.in)} must not use bare except clauses.`),
  validate({ ctx }) {
    return ctx.targetFiles.flatMap((file) =>
      file.language === ProjectFileLanguage.Python
        ? file.find(/^\s*except\s*:/gm).map((match) =>
            file.report({
              line: match.line,
              column: match.column,
              message: options.message,
              fix: options.fix ?? manualFix("Catch the narrow exception type that the block is expected to handle."),
              docs: options.docs,
            }),
          )
        : [],
    );
  },
}));
