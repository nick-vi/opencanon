import { defineConvention } from "@opencanon/core";

/**
 * no-unguarded-json-parse — robustness rule.
 *
 * Flags a `JSON.parse(...)` call that parses the result of file I/O
 * (`readFileSync`, `readFile`, a `Response`/`Bun.file` `.text()`/`.json()`, etc.)
 * when it is NOT inside an enclosing try/catch body. A malformed file would throw
 * a SyntaxError and crash the process instead of degrading gracefully.
 *
 * Backed by the engine `calls` fact, which now carries `tryDepth` (number of
 * enclosing try-BODIES) and `argumentCalls` (direct calls passed as arguments).
 */
const docs = ["docs/opencanon/canon/no-unguarded-json-parse.md#file-jsonparse-calls-are-guarded"];

const fileReadCallees = new Set(["readFileSync", "readFile", "fs.readFileSync", "fs.promises.readFile"]);
const fileReadMethods = new Set(["text", "json", "toString"]);

const convention = defineConvention({
  id: "no-unguarded-json-parse",
  title: "File JSON.parse calls are guarded",
  topics: ["robustness"],
  related: ["guard-file-json-parse"],
  rule: "JSON.parse() of file I/O must sit inside a try/catch so a malformed file degrades instead of crashing.",
  applies: { kind: "files", globs: ["packages/*/src/**/*.{ts,tsx}"] },
  render: { kind: "generated", docs: "docs/opencanon/canon/no-unguarded-json-parse.md", style: "reference" },
  runtime: {
    kind: "validator",
    severity: "warning",
    scope: "file",
    facts: ["calls"],
    fixtures: "valid-and-invalid",
    validate({ ctx }) {
      const findings = [];
      for (const call of ctx.facts.calls()) {
        if (call.callee !== "JSON.parse") continue;
        if ((call.tryDepth ?? 0) !== 0) continue;
        const readsFile = call.argumentCalls?.some(
          (arg) => fileReadCallees.has(arg.callee) || fileReadCallees.has(arg.name) || fileReadMethods.has(arg.name),
        );
        if (!readsFile) continue;
        const file = ctx.file(call.file.path);
        if (!file) continue;
        findings.push(
          file.report({
            line: call.line,
            column: call.column,
            message: "JSON.parse() of file I/O is not inside a try/catch; a malformed file will crash instead of degrading.",
            docs,
            fix: {
              safety: "manual",
              description: "Wrap the JSON.parse of file content in a try/catch that returns a sensible default or reports a diagnostic.",
            },
          }),
        );
      }
      return findings;
    },
  },
});

export default convention;
