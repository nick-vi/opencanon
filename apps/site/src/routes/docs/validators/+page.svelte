<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';
  import InfoTip from '$lib/components/InfoTip.svelte';

  const example = `import { defineValidator } from "../index.ts";

export default defineValidator({
  id: "service-no-db-client",
  topics: ["service", "data-access"],
  applies: ["src/services/**/*.ts"],
  severity: "error",
  scope: "import-edge",
  facts: ["imports"],
  decisionIds: ["service-db-boundary"],
  validate({ ctx }) {
    return ctx.facts.imports()
      .filter((edge) => edge.source.endsWith("/db/client"))
      .map((edge) => ({
        validatorId: "service-no-db-client",
        severity: "error",
        file: edge.from.path,
        line: edge.line,
        message: "Services must not import DB clients directly.",
      }));
  },
});`;
  const factoryExample = `import { defineValidator, migrationReferences, noUnusedExports, similarFunctionNames } from "../index.ts";

export default defineValidator({
  id: "project-validators",
  validators: [
    migrationReferences({
      id: "old-api-migration",
      topics: ["migration"],
      severity: "error",
      in: ["src/**/*.ts"],
      pattern: "\\\\boldApi\\\\(",
      replacement: "currentApi(",
      fixSafety: "suggested",
      message: "oldApi is replaced; use currentApi.",
    }),
    noUnusedExports({
      id: "no-unused-exports",
      topics: ["dead-code"],
      severity: "warning",
      in: ["src/**/*.ts"],
      publicSurfaces: ["src/api/**"],
      message: "Exported symbol has no known project caller.",
    }),
    similarFunctionNames({
      id: "similar-functions",
      topics: ["dry"],
      severity: "warning",
      in: ["src/**/*.ts"],
      requireSharedCallees: true,
      message: "Similar function surfaces may duplicate behavior.",
    }),
  ],
});`;
  const graphExample = `validate({ ctx }) {
  return ctx.graph.callers("loadCompany").map((edge) =>
    edge.source.file.report({
      line: edge.source.line,
      message: "loadCompany callers must use the new service boundary.",
      fix: {
        safety: "manual",
        command: "opencanon graph callees loadCompany",
        description: "Inspect downstream side effects before changing this call.",
      },
    }),
  );
}`;
  const projectTypesExample = `import { defineValidator } from "@opencanon/core";
import { Npm, Packages, Python, Cargo } from "@opencanon/project";

export default defineValidator({
  id: "typed-dependency-policy",
  topics: ["dependencies"],
  applies: ["packages/api/src/**/*.ts"],
  severity: "error",
  scope: "import-edge",
  facts: ["imports"],
  validate({ ctx }) {
    const apiPackage = Packages.API;
    const zodVersion = Npm.ZOD.version;

    return ctx.facts.imports()
      .filter((edge) => edge.fromPackage === apiPackage)
      .filter((edge) => edge.source === Npm.ZOD.name)
      .map((edge) => edge.from.report({
        line: edge.line,
        message: \`API imports \${Npm.ZOD.name} \${zodVersion}; Rust uses \${Cargo.SERDE.name} and Python uses \${Python.REQUESTS.name}.\`,
      }));
  },
});`;
  const fixtureExample = `import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  directories: ["src/services", "src/db"],
  files: ({ file }) => [
    file.ts("src/services/company.service.ts", \`
      import { db } from "../db/client";

      export function loadCompany(id: string) {
        return db.company.findUnique({ where: { id } });
      }
    \`),
    file.json("package.json", {
      dependencies: {
        zod: "^4.0.0"
      }
    }),
  ],
});`;
  const gateExample = `export default defineValidator({
  id: "auth-session-ttl-approval",
  topics: ["security"],
  applies: ["src/auth/session.ts"],
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
        approvalScope: "staged-diff",
      });
    }

    return [];
  },
});`;
  const gateCommands = `opencanon validate --changed
opencanon gate pending --format json
opencanon gate approve auth-session-ttl-change \\
  --summary "User approved changing sessionTtlDays from 365 to 730." \\
  --via agent`;
</script>

<svelte:head><title>Validators | OpenCanon</title></svelte:head>

<h1>Validators</h1>
<p class="lead">
  Validators are TypeScript functions. They read repository facts and emit
  findings. <InfoTip term="facts" id="validator-facts-tip" /> There is no DSL.
</p>

<h2>Anatomy</h2>
<CodeBlock title="service-no-db-client.ts" language="ts" code={example} />

<h2>Facts, not source</h2>
<p>
  Validators receive <code>ctx.facts</code>. Facts are extracted by the engine
  binary and cached by the daemon.
</p>

<h2>Graph-aware rules</h2>
<CodeBlock title="graph-validator.ts" language="ts" code={graphExample} />
<p>
  Validators can use <code>ctx.graph</code> for symbols, references, callers,
  callees, and impact edges. Command fixes are advisory: OpenCanon prints them
  for an agent but never executes them through <code>--fix</code>.
</p>

<h2>Curated factories</h2>
<CodeBlock title="validators/index.ts" language="ts" code={factoryExample} />
<p>
  Curated factories are opt-in. <code>migrationReferences</code> links old API
  usage to the baseline so existing matches can warn while new matches fail, and
  can emit structured replacement fixes when a replacement is configured.
  <code>noUnusedExports</code> uses graph callers and respects configured
  entrypoints and public surfaces. <code>similarFunctionNames</code> uses symbol
  and callee facts to flag likely DRY overlaps inside a scope.
</p>

<h2>Fixtures</h2>
<p>
  Every validator is paired with at least one fixture under
  <code>.agents/skills/opencanon/fixtures/</code>. Fixtures pin expected output.
  Run <code>opencanon validate --check-fixtures</code> locally or in CI.
</p>
<CodeBlock title="fixtures/auth-session-ttl/invalid.ts" language="ts" code={fixtureExample} />
<p>
  Fixtures are virtual projects. Put flat modules named <code>valid.ts</code>,
  <code>invalid.ts</code>, and optional <code>fixed.ts</code> under the
  validator fixture directory. Use <code>file.ts</code>, <code>file.tsx</code>,
  <code>file.py</code>, <code>file.rs</code>, <code>file.toml</code>,
  <code>file.md</code>, and <code>file.json</code> for readable test projects.
  Generated fixture aliases let realistic imports type-check without local
  <code>as any</code> stubs.
</p>

<h2>Typed project constants</h2>
<CodeBlock title="@opencanon/project" language="ts" code={projectTypesExample} />
<p>
  The daemon generates <code>@opencanon/project</code> from the indexed
  repository. Validators can use typed constants for workspace packages,
  package roots, import specifiers, npm dependencies, Rust crates, Cargo
  dependencies, and Python dependencies. Generated objects include JSDoc from
  package metadata where available and stay intentionally lightweight: OpenCanon
  does not generate huge symbol, literal, caller, or callee maps by default.
</p>

<h2>Commit gates</h2>
<CodeBlock title="commit-gate-validator.ts" language="ts" code={gateExample} />
<CodeBlock title="approval flow" language="shell" code={gateCommands} />
<p>
  Commit gates are for ambiguous changes that require user intent before commit
  but should not become normal findings. Approvals default to the exact staged
  staged diff for the gate evidence; use <code>approvalScope: "file"</code>
  only when the full current file content is the intended approval boundary.
  Agents should inspect the staged diff and pending gate, ask for explicit
  Approve or Reject, then record approval only after the user approves.
</p>

<h2>Decisions</h2>
<p>
  Validators reference decisions by ID. A decision explains why the rule exists
  and when it has exceptions.
</p>
