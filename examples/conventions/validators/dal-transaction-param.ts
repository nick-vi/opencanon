import { defineValidator } from "@opencanon/core";

const validator = defineValidator({
  id: "dal-transaction-param",
  topics: ["dal"],
  applies: ["src/db/dal/**/*.{ts,tsx}"],
  severity: "error",
  scope: "file",
  facts: ["symbols"],
  decisionIds: ["dal-transaction-flow"],
  validate({ ctx }) {
    const findings = [];

    for (const file of ctx.targetFiles) {
      const exportedFunctions = ctx.facts.symbols().filter((item) => item.file.path === file.path && item.kind === "function" && item.exported);

      for (const fn of exportedFunctions) {
        const lastParam = fn.params?.at(-1) ?? "";
        if (!/\btx\??\s*:/.test(lastParam)) {
          findings.push(
            file.report({
              line: fn.line,
              message: `Exported DAL function ${fn.name} should accept tx?: DatabaseClient as its final parameter.`,
              fix: {
                safety: "manual",
                description: "Add tx?: DatabaseClient as the final parameter and use const client = tx ?? db().",
              },
              docs: ["examples/conventions/docs/opencanon/decisions.json#dal-transaction-flow"],
            }),
          );
        }
      }

      if (exportedFunctions.length > 0 && !file.has(/\bconst\s+client\s*=\s*tx\s*\?\?\s*db\(\)/)) {
        findings.push(
          file.report({
            line: exportedFunctions[0].line,
            message: "DAL module should use const client = tx ?? db() before querying.",
            fix: {
              safety: "manual",
              description: "Route queries through a transaction-aware client variable.",
            },
            docs: ["examples/conventions/docs/opencanon/decisions.json#dal-transaction-flow"],
          }),
        );
      }
    }

    return findings;
  },
});

export default validator;
