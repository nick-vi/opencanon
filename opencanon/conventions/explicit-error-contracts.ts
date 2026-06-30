import { defineConvention } from "@opencanon/core";

const docs = ["docs/opencanon/canon/explicit-error-contracts.md#runtime-failures-use-explicit-error-payloads"];

const transportBoundaryGlobs = [
  "packages/runtime/src/routes.ts",
  "packages/runtime/src/server.ts",
  "packages/runtime/src/service.ts",
  "packages/runtime/src/local-protocol.ts",
  "packages/runtime/test/**/*.ts",
  "tests/contracts.test.ts",
] as const;

const staleTransportPatterns = [
  {
    pattern: /\bjson\s*\(\s*\{\s*ok\s*:\s*false\s*,\s*diagnostics\b/u,
    message: "Runtime API failures must return `{ ok: false, error }`, not top-level `diagnostics`.",
  },
  {
    pattern: /\brespondJson\s*\([^)]*\{\s*ok\s*:\s*false\s*,\s*diagnostics\b/u,
    message: "Low-level HTTP failures must return `{ ok: false, error }`, not top-level `diagnostics`.",
  },
  {
    pattern: /\bserviceJson\s*\(\s*\{\s*ok\s*:\s*false\s*,\s*diagnostics\b/u,
    message: "Service API failures must return `{ ok: false, error }`, not top-level `diagnostics`.",
  },
  {
    pattern: /\bpayload\.diagnostics\b/u,
    message: "API clients must read `payload.error`; `payload.diagnostics` is not a failure contract.",
  },
] as const;

const convention = defineConvention({
  id: "explicit-error-contracts",
  title: "Runtime failures use explicit error payloads",
  topics: ["architecture", "runtime", "robustness"],
  why: "Humans and agents need predictable failure envelopes across runtime HTTP, local IPC, CLI, MCP, and browser diagnostics. Keeping problems and diagnostics under one `error` key prevents ambiguity with successful response diagnostics.",
  rule: "OpenCanon transport failures return `{ ok: false, error }`, where `error.kind` is either `problem` or `diagnostics`; top-level `diagnostics` remains internal/domain data only.",
  impactSurfaces: ["local-service-control"],
  examples: [
    { note: "Use `diagnosticsFailure(...)` or `diagnostic(...)` at runtime route boundaries." },
    { note: "Use `error: { kind: \"problem\", problem }` for predictable user-facing remediation such as project-open failures." },
    { note: "Keep validation and settings internals free to return `diagnostics` until they are wrapped at HTTP, IPC, CLI, or MCP boundaries." },
  ],
  applies: { kind: "files", globs: [...transportBoundaryGlobs] },
  render: { kind: "generated", docs: "docs/opencanon/canon/explicit-error-contracts.md", style: "reference" },
  runtime: {
    kind: "validator",
    severity: "error",
    scope: "project",
    facts: [],
    fixtures: "valid-and-invalid",
    validate({ ctx }) {
      const findings = [];
      for (const file of ctx.projectFiles([...transportBoundaryGlobs])) {
        for (const stale of staleTransportPatterns) {
          for (const match of file.find(stale.pattern)) {
            findings.push(
              file.report({
                line: match.line,
                column: match.column,
                message: stale.message,
                docs,
                fix: {
                  safety: "manual",
                  description: "Wrap failure diagnostics in `error: { kind: \"diagnostics\", diagnostics }` or emit a structured `problem` payload.",
                },
              }),
            );
          }
        }
      }
      return findings;
    },
  },
});

export default convention;
