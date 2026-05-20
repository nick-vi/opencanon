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
  const factoryExample = `import { defineValidator, migrationReferences, noUnusedExports } from "../index.ts";

export default defineValidator({
  id: "project-validators",
  validators: [
    migrationReferences({
      id: "old-api-migration",
      topics: ["migration"],
      severity: "error",
      in: ["src/**/*.ts"],
      pattern: "\\\\boldApi\\\\(",
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
  usage to the baseline so existing matches can warn while new matches fail.
  <code>noUnusedExports</code> uses graph callers and respects configured
  entrypoints and public surfaces.
</p>

<h2>Fixtures</h2>
<p>
  Every validator is paired with at least one fixture under
  <code>.agents/skills/opencanon/fixtures/</code>. Fixtures pin expected output.
  Run <code>opencanon validate --check-fixtures</code> locally or in CI.
</p>

<h2>Decisions</h2>
<p>
  Validators reference decisions by ID. A decision explains why the rule exists
  and when it has exceptions.
</p>
