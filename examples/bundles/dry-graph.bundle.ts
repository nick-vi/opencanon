export default {
  id: "dry-graph",
  description: "Adds graph-backed DRY validators for repeated literals and similar function surfaces.",
  topics: ["dry", "code-quality"],
  validators: ["repeated-domain-literals", "similar-functions"],
  options: {
    sourceGlobs: {
      type: "string[]",
      default: ["src/**/*.ts", "src/**/*.tsx", "packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
      description: "Source globs checked by the DRY validators.",
    },
    minLiteralOccurrences: {
      type: "number",
      default: 3,
      description: "Minimum literal occurrences before repeated literals are reported.",
    },
    minFunctionSimilarity: {
      type: "number",
      default: 0.82,
      description: "Similarity threshold for function names after action verb normalization.",
    },
  },
  docs: [
    {
      path: "docs/opencanon/canon/dry.md",
      heading: "Graph Backed DRY",
      body: [
        "DRY checks combine literal facts, symbol facts, and call graph facts.",
        "",
        "Rules:",
        "",
        "- Repeated domain literals should move behind named constants or const-object patterns.",
        "- Similar function surfaces with shared callees should be reviewed for duplicate behavior.",
        "- Public API entrypoints can be excluded per validator when repeated naming is intentional.",
      ].join("\n"),
    },
  ],
  decisions: [
    {
      id: "graph-backed-dry-current",
      date: "2026-05-20",
      status: "current",
      title: "DRY validators use graph and literal facts",
      topics: ["dry", "code-quality"],
      applies: ["src/**", "packages/*/src/**"],
      summary: "Repeated literals and likely duplicate function surfaces are checked from structured facts.",
      rationale: ["Agents need precise DRY signals that are scoped to code boundaries and call flow."],
      required: ["Review repeated domain literals and similar function surfaces before adding new copies."],
      replaced: [],
      agentPolicy: ["Prefer extracting shared behavior or naming constants when graph-backed DRY validators report findings."],
      exceptions: [],
      docs: ["docs/opencanon/canon/dry.md#graph-backed-dry"],
      validatorIds: ["repeated-domain-literals", "similar-functions"],
    },
  ],
  files: [
    {
      path: ".agents/skills/opencanon/validators/dry-graph.ts",
      content: `import { repeatedLiterals, similarFunctionNames } from "@opencanon/validators";

const sourceGlobs = "{{sourceGlobs}}".split(",").map((item) => item.trim()).filter(Boolean);

export const repeatedDomainLiterals = repeatedLiterals({
  id: "repeated-domain-literals",
  topics: ["dry", "domain-model"],
  decisionIds: ["graph-backed-dry-current"],
  in: sourceGlobs,
  severity: "warning",
  minOccurrences: Number("{{minLiteralOccurrences}}"),
  minFiles: 1,
  message: "Repeated domain literals should be extracted.",
  docs: ["docs/opencanon/canon/dry.md#graph-backed-dry"],
});

export const similarFunctions = similarFunctionNames({
  id: "similar-functions",
  topics: ["dry", "code-quality"],
  decisionIds: ["graph-backed-dry-current"],
  in: sourceGlobs,
  severity: "warning",
  minSimilarity: Number("{{minFunctionSimilarity}}"),
  requireSharedCallees: true,
  message: "Similar function surfaces may duplicate behavior.",
  docs: ["docs/opencanon/canon/dry.md#graph-backed-dry"],
});

export default [repeatedDomainLiterals, similarFunctions];
`,
    },
    {
      path: ".agents/skills/opencanon/fixtures/similar-functions/valid.ts",
      content: "import { defineFixture } from '@opencanon/core/testing';\n\nexport default defineFixture({ files: ({ file }) => [file('src/company.ts', \"function normalizeCompany() { return true; }\\nexport function loadCompany() { return normalizeCompany(); }\\nexport function renderAccount() { return true; }\\n\")] });\n",
    },
    {
      path: ".agents/skills/opencanon/fixtures/similar-functions/invalid.ts",
      content: "import { defineFixture } from '@opencanon/core/testing';\n\nexport default defineFixture({ files: ({ file }) => [file('src/company.ts', \"function normalizeCompany() { return true; }\\nexport function loadCompany() { return normalizeCompany(); }\\nexport function fetchCompany() { return normalizeCompany(); }\\n\")] });\n",
    },
    {
      path: ".agents/skills/opencanon/fixtures/repeated-domain-literals/valid.ts",
      content: "import { defineFixture } from '@opencanon/core/testing';\n\nexport default defineFixture({ files: ({ file }) => [file('src/orders.ts', \"const ORDER_TYPE = \\\"ORDER\\\";\\nconst STATUS_PENDING = \\\"pending\\\";\\nexport function loadOrder() { return { type: ORDER_TYPE, status: STATUS_PENDING }; }\\nexport function fetchOrder() { return { type: ORDER_TYPE, status: STATUS_PENDING }; }\\n\")] });\n",
    },
    {
      path: ".agents/skills/opencanon/fixtures/repeated-domain-literals/invalid.ts",
      content: "import { defineFixture } from '@opencanon/core/testing';\n\nexport default defineFixture({ files: ({ file }) => [file('src/orders.ts', \"export function loadOrder() { return { type: \\\"ORDER\\\", status: \\\"pending\\\" }; }\\nexport function fetchOrder() { return { type: \\\"ORDER\\\", status: \\\"pending\\\" }; }\\n\")] });\n",
    },
  ],
  impactSurfaces: [],
  externalTools: {},
};
