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
