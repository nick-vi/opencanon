<script>
  import Specimen from '$lib/Specimen.svelte';

  const a = `import { db } from "../db/client";

export class CompanyService {
  async deactivate(id: string) {
    return db.from("companies").where({ id }).update({ status: "x" });
  }
}`;
  const aF = [
    {
      line: 1,
      severity: 'error',
      rule: 'service-no-db-client',
      message: 'service imports db client',
      detail: 'Route persistence through a repository in src/repositories/.'
    },
    {
      line: 5,
      severity: 'warn',
      rule: 'repeated-domain-literals',
      message: '"companies" appears in 6 services',
      detail: 'Extract into the shared domain table registry.'
    }
  ];

  const b = `// opencanon/conventions/index.ts
export default [
  serviceDbBoundary,
  repeatedDomainLiterals,
  noDumpsterFolders,
];`;
  const bF = [
    {
      line: 2,
      severity: 'warn',
      rule: 'generated-doc-drift',
      message: 'generated docs are stale',
      detail: 'Run opencanon canon render conventions, then review the Markdown diff.'
    }
  ];

  const c = `{
  "ok": false,
  "error": {
    "kind": "problem",
    "message": "Project runtime is not initialized",
    "action": "Run opencanon setup --yes"
  }
}`;
  const cF = [
    {
      line: 3,
      severity: 'error',
      rule: 'explicit-error-contracts',
      message: 'runtime failure is explicit',
      detail: 'Clients receive one error payload with a predictable recovery action.'
    }
  ];
</script>

<svelte:head><title>Output | OpenCanon</title></svelte:head>

<article class="page">
  <header class="head">
    <p class="smallcaps">Finding output</p>
    <h1>Output examples.</h1>
    <p class="dek">
      Findings rendered as code, margin signals, and action details. Each
      example comes from a validator in this repo.
    </p>
  </header>

  <Specimen
    caption="A service that reaches across the db boundary."
    path="src/services/company.service.ts"
    source={a}
    findings={aF}
  />

  <div class="gap"></div>

  <Specimen
    caption="Generated docs drift check."
    path="opencanon/conventions/index.ts"
    source={b}
    findings={bF}
  />

  <div class="gap"></div>

  <Specimen
    caption="Explicit runtime error contract."
    path="runtime-response.json"
    source={c}
    findings={cF}
  />
</article>

<style>
  .page {
    max-width: 60rem;
    margin: 0 auto;
    padding: var(--space-7) var(--space-6);
  }
  .head { margin-bottom: var(--space-7); max-width: 50rem; }
  .head h1 {
    font-size: var(--step-5);
    margin: var(--space-3) 0 var(--space-4);
    line-height: 1.05;
    letter-spacing: 0;
  }
  .dek {
    font-size: var(--step-2);
    color: var(--c-ink-soft);
    max-width: 50ch;
  }
  .gap { height: var(--space-6); }
</style>
