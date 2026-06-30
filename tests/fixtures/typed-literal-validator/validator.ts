import { defineConvention } from "@opencanon/core";

/**
 * Demo convention exercising both deliverables:
 *   - `ctx.typed.literal({ declarationSourceId })` for syntactic same-file lookup.
 *   - `ctx.typed.literal({ surroundingTypeName })` for producer-resolved
 *     surrounding-type filtering (sidecar/live producer).
 */
export const typedLiteralValidator = defineConvention({
  id: "typed-literal-demo",
  title: "Typed Literal Demo",
  topics: ["typed-literals"],
  rule: "Typed literal facts can be filtered by declaration source or surrounding type.",
  applies: { kind: "files", globs: ["src/**/*.ts"] },
  render: { kind: "none" },
  runtime: {
    kind: "validator",
    severity: "warning",
    scope: "file",
    facts: ["literals"],
    validate({ ctx }) {
      const declared = ctx.typed.literal({ declarationSourceId: "Status", valueKind: "string" });
      const typed = ctx.typed.literal({ surroundingTypeName: "Status", valueKind: "string" });
      return [
        ...declared.map((literal) =>
          literal.file.report({
            line: literal.line,
            column: literal.column,
            message: `Status declaration carries literal ${JSON.stringify(literal.value)}.`,
          }),
        ),
        ...typed.map((literal) =>
          literal.file.report({
            line: literal.line,
            column: literal.column,
            message: `Comparison literal ${JSON.stringify(literal.value)} is typed against Status.`,
          }),
        ),
      ];
    },
  },
});
