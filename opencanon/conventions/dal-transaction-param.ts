import { defineConvention } from "@opencanon/core";

const convention = defineConvention({
  id: "dal-transaction-param",
  title: "DAL functions keep transaction clients last",
  topics: ["dal"],
  related: ["dal-transaction-flow"],
  rule: "Exported DAL functions should accept an optional transaction/client parameter and route queries through a transaction-aware client.",
  applies: { kind: "files", globs: ["src/db/dal/**/*.{ts,tsx}"] },
  render: { kind: "generated", docs: "docs/opencanon/canon/dal-transaction-param.md", style: "reference" },
  runtime: {
    kind: "validator",
    severity: "error",
    scope: "file",
    facts: ["symbols"],
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
                docs: ["docs/opencanon/canon/dal-transaction-param.md#dal-functions-keep-transaction-clients-last"],
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
              docs: ["docs/opencanon/canon/dal-transaction-param.md#dal-functions-keep-transaction-clients-last"],
            }),
          );
        }
      }

      return findings;
    },
  },
});

export default convention;
