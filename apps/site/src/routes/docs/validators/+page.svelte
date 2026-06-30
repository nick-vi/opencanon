<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';
  import InfoTip from '$lib/components/InfoTip.svelte';

  const conventionExample = `import { defineConvention } from "@opencanon/core";

export default defineConvention({
  id: "service-db-boundary",
  title: "Services compose DAL instead of direct DB clients",
  topics: ["service", "dal"],
  why: "DAL modules keep table/query details in one layer.",
  rule: "Services own workflow composition but should use DAL modules for persistence details.",
  applies: { kind: "files", globs: ["src/services/**/*.ts"] },
  render: {
    kind: "generated",
    docs: "docs/opencanon/canon/service-db-boundary.md",
    style: "reference"
  },
  runtime: {
    kind: "validator",
    severity: "error",
    scope: "import-edge",
    facts: ["imports"],
    validate({ ctx }) {
      return ctx.facts.imports()
        .filter((edge) => edge.source.endsWith("/db/client"))
        .map((edge) => edge.from.report({
          line: edge.line,
          message: "Services must not import DB clients directly."
        }));
    }
  }
});`;

  const graphExample = `runtime: {
  kind: "validator",
  severity: "warning",
  scope: "project",
  facts: ["graph"],
  validate({ ctx }) {
    return ctx.graph.callers("loadCompany").map((edge) =>
      edge.source.file.report({
        line: edge.source.line,
        message: "Inspect loadCompany side effects before changing this call.",
        fix: {
          safety: "manual",
          command: "opencanon graph callees loadCompany",
          description: "Inspect downstream side effects before changing this call."
        }
      })
    );
  }
}`;

  const fixtureExample = `import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/services/company.service.ts", \`
      import { db } from "../db/client";

      export function loadCompany(id: string) {
        return db.company.findUnique({ where: { id } });
      }
    \`)
  ]
});`;

  const gateExample = `runtime: {
  kind: "gate",
  severity: "error",
  scope: "file",
  facts: ["literals"],
  validate({ ctx }) {
    for (const file of ctx.targetFiles) {
      if (!file.text.includes("sessionTtlDays")) continue;

      ctx.commitGate({
        id: "auth-session-ttl-change",
        title: "Auth session TTL changed",
        reason: "Session duration affects security and product behavior.",
        question: "Did the user approve this auth session TTL change?",
        file: file.path,
        evidence: [{ file: file.path }],
        approvalScope: "staged-diff"
      });
    }

    return [];
  }
}`;

  const commands = `opencanon validate --check-fixtures
opencanon validate --changed
opencanon gate pending --format json
opencanon gate approve auth-session-ttl-change \\
  --summary "User approved changing sessionTtlDays from 365 to 730." \\
  --via agent`;
</script>

<svelte:head><title>Proof | OpenCanon</title></svelte:head>

<h1>Proof</h1>
<p class="lead">
  Proof is how Project Canon becomes more than prose. Validators, gates,
  fixtures, Doctor, generated-doc drift checks, and declared task checks all
  verify that implementation still matches the canon.
</p>

<h2>Convention with runtime validator</h2>
<p>
  A convention can own the prose, scope, generated docs, and runtime enforcement
  in one definition. <InfoTip term="validators" id="validator-proof-tip" />
</p>
<CodeBlock title="service-db-boundary.ts" language="ts" code={conventionExample} />

<h2>Facts, not string scans</h2>
<p>
  Validators read structured facts from the project runtime. Facts include
  imports, exports, calls, comments, literals, dependency metadata, graph edges,
  and file content when a file-scoped check genuinely needs text.
</p>

<h2>Graph-aware checks</h2>
<CodeBlock title="graph validator" language="ts" code={graphExample} />
<p>
  Graph-backed checks can inspect symbols, references, callers, callees, and
  impact edges before a risky edit spreads.
</p>

<h2>Fixtures</h2>
<p>
  Fixtures are tiny virtual projects that pin expected behavior. They live under
  <code>opencanon/fixtures/</code> and run with the same validator engine as
  real project files.
</p>
<CodeBlock title="opencanon/fixtures/service-db-boundary/invalid.ts" language="ts" code={fixtureExample} />

<h2>Commit gates</h2>
<p>
  Gates are for ambiguous changes that require user intent before commit. They
  produce pending approvals rather than normal findings.
</p>
<CodeBlock title="gate runtime" language="ts" code={gateExample} />
<CodeBlock title="approval flow" language="shell" code={commands} />

<h2>Generated docs stay derived</h2>
<p>
  OpenCanon-owned Markdown is rendered from definitions. Doctor rerenders and
  diffs generated docs so humans get clean prose without making Markdown a
  second source of truth.
</p>
