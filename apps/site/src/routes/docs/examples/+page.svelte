<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';
  import BeforeAfter from '$lib/components/BeforeAfter.svelte';

  const scenarios = [
    {
      id: 'migration',
      label: 'Migration Control',
      summary:
        'Turn an active migration into a convention, fixtures, generated docs, and a changed-file check.',
      steps: [
        {
          label: 'Initialize',
          command: 'opencanon setup --yes --hooks codex',
          output: 'Project Canon scaffolded. Hooks installed. Doctor checked.'
        },
        {
          label: 'Define',
          command: 'edit opencanon/conventions/index.ts',
          output: 'Added migration-control convention with runtime validator and fixtures.'
        },
        {
          label: 'Render',
          command: 'opencanon canon render conventions',
          output: 'Rendered docs/opencanon/canon/migrations.md from the convention definition.'
        },
        {
          label: 'Validate',
          command: 'opencanon validate --changed',
          output: 'old-api-migration src/orders.ts:2 Replaced API usage must not be introduced.'
        }
      ],
      treeBefore: `migration-control/before
├─ package.json
└─ src/
   └─ orders.ts`,
      treeAfter: `migration-control/after
├─ package.json
├─ .gitignore
├─ src/
│  └─ orders.ts
├─ opencanon/
│  ├─ conventions/index.ts
│  └─ fixtures/migration-control/
├─ docs/opencanon/
│  └─ canon/migrations.md
└─ .opencanon/ # gitignored derived state`,
      finding: {
        rule: 'old-api-migration',
        severity: 'error',
        file: 'src/orders.ts:2',
        message: 'Replaced API usage must not be introduced.',
        fix: 'suggested edit: oldApi -> currentApi'
      },
      artifacts: {
        code: {
          before: `export function submitOrder(input: { total: number }) {
  return oldApi(input);
}`,
          after: `export function submitOrder(input: { total: number }) {
  return currentApi(input);
}`
        },
        docs: {
          before: `# No local migration rule yet`,
          after: `# Migration control

Rule: New code must not call replaced APIs.

Proof: changed-file validation blocks new matches and fixtures pin the behavior.`
        },
        definition: {
          before: `// no Project Canon definition yet`,
          after: `defineConvention({
  id: "old-api-migration",
  title: "Old API usage does not spread",
  rule: "New code must call currentApi instead of oldApi.",
  applies: { kind: "files", globs: ["src/**/*.ts"] },
  render: { kind: "generated", docs: "docs/opencanon/canon/migrations.md" },
  runtime: { kind: "validator", severity: "error", scope: "file", facts: [] }
});`
        },
        fixture: {
          before: `// no fixture coverage`,
          after: `valid.ts
currentApi();

invalid.ts
oldApi();`
        }
      }
    },
    {
      id: 'dry',
      label: 'Graph-backed DRY',
      summary: 'Use symbols, literals, and callee facts to catch repeated domain behavior before it spreads.',
      steps: [
        {
          label: 'Explore',
          command: 'opencanon search loadCompany',
          output: 'Found function loadCompany and related docs, conventions, and graph facts.'
        },
        {
          label: 'Inspect',
          command: 'opencanon graph callees loadCompany',
          output: 'loadCompany calls normalizeCompany.'
        },
        {
          label: 'Prove',
          command: 'opencanon validate --project',
          output: 'similar-functions src/company.ts:9 Similar function surfaces may duplicate behavior.'
        },
        {
          label: 'Fix',
          command: 'opencanon changes check area-change-model --task examples-current-canon --all',
          output: 'Declared checks passed after merging duplicate surface and extracting CompanyTable.'
        }
      ],
      treeBefore: `dry-graph/before
├─ package.json
└─ src/
   └─ company.ts`,
      treeAfter: `dry-graph/after
├─ package.json
├─ .gitignore
├─ src/
│  └─ company.ts
├─ opencanon/
│  ├─ conventions/index.ts
│  └─ fixtures/fact-backed-dry/
├─ docs/opencanon/
│  └─ canon/dry.md
└─ .opencanon/ # gitignored derived state`,
      finding: {
        rule: 'similar-functions',
        severity: 'warning',
        file: 'src/company.ts:9',
        message: 'Similar function surfaces may duplicate behavior.',
        fix: 'manual review: compare callers/callees, then merge or rename'
      },
      artifacts: {
        code: {
          before: `export function loadCompany(id: string) {
  return { table: "companies", normalized: normalizeCompany(id) };
}

export function fetchCompany(id: string) {
  return { table: "companies", normalized: normalizeCompany(id) };
}`,
          after: `const CompanyTable = "companies";

export function loadCompany(id: string) {
  return { table: CompanyTable, normalized: normalizeCompany(id) };
}`
        },
        docs: {
          before: `# No local DRY rule yet`,
          after: `# Graph-backed DRY

Rule: Repeated domain literals and similar function surfaces should be reviewed before adding another copy.`
        },
        definition: {
          before: `// no graph-backed convention yet`,
          after: `defineConvention({
  id: "fact-backed-dry",
  title: "Graph facts guide DRY cleanup",
  rule: "Repeated literals and similar functions should be reviewed before duplication spreads.",
  applies: { kind: "files", globs: ["src/**/*.ts"] },
  runtime: { kind: "validator", severity: "warning", scope: "project", facts: ["graph"] }
});`
        },
        fixture: {
          before: `// no fixture coverage`,
          after: `valid.ts
loadCompany();
renderAccount();

invalid.ts
loadCompany();
fetchCompany();`
        }
      }
    }
  ];

  const artifactTabs = [
    { id: 'code', label: 'Source' },
    { id: 'docs', label: 'Docs' },
    { id: 'definition', label: 'Definition' },
    { id: 'fixture', label: 'Fixtures' }
  ];

  let selectedId = $state('migration');
  let activeStep = $state(0);
  let activeArtifact = $state('code');

  const scenario = $derived(scenarios.find((item) => item.id === selectedId) ?? scenarios[0]);
  const step = $derived(scenario.steps[activeStep] ?? scenario.steps[0]);
  const artifact = $derived(scenario.artifacts[activeArtifact]);
  const artifactLang = $derived(activeArtifact === 'docs' ? 'md' : 'ts');

  function selectScenario(id) {
    selectedId = id;
    activeStep = 0;
    activeArtifact = 'code';
  }
</script>

<svelte:head><title>Examples | OpenCanon</title></svelte:head>

<h1>Project Examples</h1>
<p class="lead">
  Small before and after projects showing how Project Canon definitions, generated docs,
  fixtures, Knowledge, and Proof work together.
</p>

<div class="scenario-tabs" role="tablist" aria-label="Example scenarios">
  {#each scenarios as item}
    <button
      type="button"
      role="tab"
      aria-selected={selectedId === item.id}
      class:active={selectedId === item.id}
      onclick={() => selectScenario(item.id)}
    >
      {item.label}
    </button>
  {/each}
</div>

<section class="example-section">
  <div class="section-heading">
    <h2>{scenario.label}</h2>
    <p>{scenario.summary}</p>
  </div>

  <div class="step-tabs" role="tablist" aria-label="Example workflow">
    {#each scenario.steps as item, index}
      <button
        type="button"
        role="tab"
        aria-selected={activeStep === index}
        class:active={activeStep === index}
        onclick={() => (activeStep = index)}
      >
        {index + 1}. {item.label}
      </button>
    {/each}
  </div>

  <div class="command-card">
    <p class="eyebrow">Command</p>
    <CodeBlock language="sh" code={step.command} />
    <p class="eyebrow">Output</p>
    <CodeBlock language="text" code={step.output} />
  </div>
</section>

<section class="example-section">
  <div class="section-heading">
    <h2>Result</h2>
    <p>{scenario.finding.message}</p>
  </div>
  <dl class="finding">
    <div><dt>Rule</dt><dd>{scenario.finding.rule}</dd></div>
    <div><dt>Severity</dt><dd>{scenario.finding.severity}</dd></div>
    <div><dt>Location</dt><dd>{scenario.finding.file}</dd></div>
    <div><dt>Action</dt><dd>{scenario.finding.fix}</dd></div>
  </dl>
</section>

<section class="example-section">
  <div class="section-heading">
    <h2>Project Shape</h2>
    <p>What the project looks like before and after OpenCanon setup.</p>
  </div>
  <BeforeAfter before={scenario.treeBefore} after={scenario.treeAfter} language="tree" />
</section>

<section class="example-section">
  <div class="section-heading">
    <h2>Artifacts</h2>
    <p>Switch between source, generated docs, Project Canon source, and fixtures.</p>
  </div>

  <div class="artifact-tabs" role="tablist" aria-label="Artifact type">
    {#each artifactTabs as tab}
      <button
        type="button"
        role="tab"
        aria-selected={activeArtifact === tab.id}
        class:active={activeArtifact === tab.id}
        onclick={() => (activeArtifact = tab.id)}
      >
        {tab.label}
      </button>
    {/each}
  </div>

  <BeforeAfter before={artifact.before} after={artifact.after} language={artifactLang} mode="diff" />
</section>

<style>
  .lead {
    max-width: 42rem;
  }

  .scenario-tabs,
  .step-tabs,
  .artifact-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: var(--space-3) 0;
  }

  button {
    min-height: 1.95rem;
    border: 1px solid var(--c-rule);
    border-radius: var(--radius-1);
    background: var(--c-paper);
    color: var(--c-ink-soft);
    padding: 0.32rem 0.58rem;
    font: inherit;
    font-size: 0.84rem;
    line-height: 1.2;
    cursor: pointer;
  }

  button:hover,
  button.active {
    color: var(--c-ink);
    background: var(--c-surface);
  }

  button.active {
    border-color: var(--c-mark);
  }

  .example-section {
    margin-top: var(--space-5);
    padding-top: var(--space-4);
    border-top: 1px solid var(--c-rule);
  }

  .section-heading {
    display: grid;
    gap: 0.35rem;
    margin-bottom: var(--space-4);
  }

  .section-heading h2,
  .section-heading p {
    margin: 0;
  }

  .command-card {
    display: grid;
    gap: var(--space-3);
  }

  .finding {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-3);
    margin: 0;
  }

  .finding div {
    border: 1px solid var(--c-rule);
    border-radius: var(--radius-1);
    padding: var(--space-3);
    background: var(--c-surface);
  }

  .finding dt {
    font: 700 0.74rem/1 var(--font-sans);
    color: var(--c-ink-muted);
    text-transform: uppercase;
  }

  .finding dd {
    margin: var(--space-2) 0 0;
    color: var(--c-ink);
  }

  @media (max-width: 760px) {
    .finding {
      grid-template-columns: 1fr;
    }
  }
</style>
