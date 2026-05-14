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

  const b = `// validators/index.ts
export {
  serviceNoDbClient,
  repeatedDomainLiterals,
  noDumpsterFolders,
} from "./registry";`;
  const bF = [
    {
      line: 2,
      severity: 'warn',
      rule: 'validators-entrypoint-shape',
      message: 'expected default export removed',
      detail: 'Validator entrypoint exports named factories only.'
    }
  ];

  const c = `// .agents/skills/opencanon/index.ts
import { defineValidator } from "@opencanon/core"; // ← not allowed
import { defineValidator } from "../runtime/core.js"; // ← fixed`;
  const cF = [
    {
      line: 2,
      severity: 'error',
      rule: 'skill-no-workspace-imports',
      message: 'workspace package import in skill barrel',
      detail: 'The skill imports from runtime/.'
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
    caption="Validator registry shape check."
    path="validators/index.ts"
    source={b}
    findings={bF}
  />

  <div class="gap"></div>

  <Specimen
    caption="Skill self-containment check."
    path=".agents/skills/opencanon/index.ts"
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
