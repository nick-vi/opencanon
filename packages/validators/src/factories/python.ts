import { createValidatorFactory } from "@opencanon/core";
import { joinPatterns, manualFix, optionSummary } from "../shared.ts";
import type { NoBareExceptOptions } from "../shared.ts";

export const noBareExcept = createValidatorFactory<NoBareExceptOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "file",
  decisionIds: options.decisionIds,
  summary: optionSummary(options, `Python files matching ${joinPatterns(options.in)} must not use bare except clauses.`),
  validate({ ctx }) {
    return ctx.targetFiles.flatMap((file) =>
      file.language === "python"
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
