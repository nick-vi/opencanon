<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';
  import BeforeAfter from '$lib/components/BeforeAfter.svelte';

  const scenarios = [
    {
      id: 'migration',
      label: 'Migration Control',
      summary:
        'Block new usage of a replaced API while keeping existing migration debt visible.',
      steps: [
        {
          label: 'Inspect',
          command: 'opencanon bundle inspect examples/bundles/migration-control.bundle.ts',
          output: 'Bundle: migration-control\nDocs: migrations.md\nFiles: migration-control.ts, old-api-migration fixtures'
        },
        {
          label: 'Plan',
          command:
            'opencanon bundle plan examples/bundles/migration-control.bundle.ts --option oldPattern="\\\\boldApi\\\\b" --option replacement=currentApi',
          output: 'Plan: add migration docs, decision, validator, valid fixture, invalid fixture'
        },
        {
          label: 'Validate',
          command: 'opencanon validate --changed',
          output: 'old-api-migration src/orders.ts:2 Replaced API usage must not be introduced.'
        },
        {
          label: 'Fix',
          command: 'opencanon validate --changed --fix suggested',
          output: 'Fix plan: replace oldApi with currentApi in src/orders.ts'
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
├─ docs/opencanon/
│  ├─ canon/migrations.md
│  └─ decisions.json
├─ .opencanon/
│  └─ cache/ # gitignored
└─ .agents/skills/opencanon/
   ├─ .gitignore
   ├─ validators/migration-control.ts
   ├─ fixtures/old-api-migration/
   └─ runtime/ # gitignored`,
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
          after: `# Migrations

## Migration Control

New code must not call replaced APIs. Existing matches can be recorded in the baseline while they are being retired.`
        },
        validator: {
          before: `// no migration validator installed`,
          after: `export default migrationReferences({
  id: "old-api-migration",
  in: ["src/**/*.ts"],
  pattern: "\\\\boldApi\\\\b",
  replacement: "currentApi",
  fixSafety: "suggested",
  existingSeverity: "warning",
  newSeverity: "error",
  message: "Replaced API usage must not be introduced.",
});`
        },
        fixture: {
          before: `// no fixture coverage`,
          after: `valid/src/orders.ts
currentApi();

invalid/src/orders.ts
oldApi();`
        }
      }
    },
    {
      id: 'dry',
      label: 'Graph DRY',
      summary: 'Use literals, symbols, and callee facts to flag likely duplicate behavior.',
      steps: [
        {
          label: 'Inspect',
          command: 'opencanon bundle inspect examples/bundles/dry-graph.bundle.ts',
          output: 'Bundle: dry-graph\nValidators: repeated-domain-literals, similar-functions'
        },
        {
          label: 'Plan',
          command: 'opencanon bundle plan examples/bundles/dry-graph.bundle.ts',
          output: 'Plan: add DRY docs, decision, graph-backed validators, similar-function fixtures'
        },
        {
          label: 'Validate',
          command: 'opencanon validate --project',
          output: 'similar-functions at src/company.ts line 5: duplicate-looking function surface.'
        },
        {
          label: 'Review',
          command: 'opencanon graph callees loadCompany && opencanon graph callees fetchCompany',
          output: 'Both functions call normalizeCompany. Agent merges the duplicate surface and extracts CompanyTable.'
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
├─ docs/opencanon/
│  ├─ canon/dry.md
│  └─ decisions.json
├─ .opencanon/
│  └─ cache/ # gitignored
└─ .agents/skills/opencanon/
   ├─ .gitignore
   ├─ validators/dry-graph.ts
   ├─ fixtures/similar-functions/
   └─ runtime/ # gitignored`,
      finding: {
        rule: 'similar-functions',
        severity: 'warning',
        file: 'src/company.ts:5',
        message: 'Similar function surfaces may duplicate behavior.',
        fix: 'manual review: compare callers/callees, then merge or rename'
      },
      artifacts: {
        code: {
          before: `function normalizeCompany(id: string) {
  return id.trim().toLowerCase();
}

export function loadCompany(id: string) {
  const normalized = normalizeCompany(id);
  return { table: "companies", normalized };
}

export function fetchCompany(id: string) {
  const normalized = normalizeCompany(id);
  return { table: "companies", normalized };
}`,
          after: `const CompanyTable = "companies";

function normalizeCompany(id: string) {
  return id.trim().toLowerCase();
}

export function loadCompany(id: string) {
  const normalized = normalizeCompany(id);
  return { table: CompanyTable, normalized };
}`
        },
        docs: {
          before: `# No DRY convention yet`,
          after: `# Code Quality

## Graph Backed DRY

Repeated domain literals and similar function surfaces should be reviewed before adding another copy.`
        },
        validator: {
          before: `// no graph-backed DRY validator installed`,
          after: `export default [
  repeatedLiterals({
    id: "repeated-domain-literals",
    minOccurrences: 2,
    message: "Repeated domain literals should be extracted.",
  }),
  similarFunctionNames({
    id: "similar-functions",
    requireSharedCallees: true,
    message: "Similar function surfaces may duplicate behavior.",
  }),
];`
        },
        fixture: {
          before: `// no fixture coverage`,
          after: `valid/src/company.ts
function normalizeCompany() { return true; }
export function loadCompany() { return normalizeCompany(); }
export function renderAccount() { return true; }

invalid/src/company.ts
function normalizeCompany() { return true; }
export function loadCompany() { return normalizeCompany(); }
export function fetchCompany() { return normalizeCompany(); }`
        }
      }
    }
  ];

  const artifactTabs = [
    { id: 'code', label: 'Source' },
    { id: 'docs', label: 'Docs' },
    { id: 'validator', label: 'Validator' },
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
  Small before and after projects that show how bundles install docs, validators, fixtures,
  and agent-facing checks.
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
    <p>What the project looks like before and after installing the bundle.</p>
  </div>
  <BeforeAfter before={scenario.treeBefore} after={scenario.treeAfter} language="tree" />
</section>

<section class="example-section">
  <div class="section-heading">
    <h2>Artifacts</h2>
    <p>Switch between the source, docs, validator, and fixture files created by the bundle.</p>
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

  .section-heading :global(h2) {
    border-top: 0;
    padding-top: 0;
    font-size: 1.05rem;
  }

  .section-heading p {
    color: var(--c-ink-soft);
  }

  .command-card {
    border: 1px solid var(--c-rule);
    border-radius: var(--radius-2);
    background: var(--c-surface);
    padding: var(--space-3);
  }

  .eyebrow {
    margin: var(--space-3) 0 var(--space-2);
    color: var(--c-ink-soft);
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .eyebrow:first-child {
    margin-top: 0;
  }

  .eyebrow + :global(.code-block) {
    margin-bottom: var(--space-3);
  }

  .command-card :global(.code-block) {
    margin-top: 0;
    margin-bottom: 0;
  }

  .finding {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 0;
  }

  .finding div {
    border: 1px solid var(--c-rule);
    border-radius: var(--radius-1);
    padding: 0.8rem;
    background: var(--c-surface);
  }

  .finding dt {
    color: var(--c-ink-soft);
    font-size: 0.78rem;
  }

  .finding dd {
    margin: 0.2rem 0 0;
    overflow-wrap: anywhere;
  }

  @media (max-width: 760px) {
    .command-card {
      padding: var(--space-3);
    }

    .finding {
      grid-template-columns: 1fr;
    }
  }
</style>
