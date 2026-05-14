<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';

  const contextCommand = `opencanon context --files src/services/company.service.ts`;
  const rulesCommand = `opencanon rules --validator service-no-db-client
opencanon rules --decision service-db-boundary`;
  const validateCommand = `opencanon validate --changed
opencanon validate --changed --strict-warnings`;
  const feedbackCommand = `opencanon feedback --changed`;
  const openCommand = `opencanon daemon open`;
</script>

<svelte:head><title>Quickstart | OpenCanon</title></svelte:head>

<h1>Quickstart</h1>
<p class="lead">
  Load rules for a file, validate changes, and return findings to the agent
  loop.
</p>

<h2>1. Load context for a file</h2>
<p>
  Ask OpenCanon what applies to a file. It returns docs, decisions, validators,
  and optional Git history.
</p>
<CodeBlock title="context" language="shell" code={contextCommand} />

<h2>2. List the rules in play</h2>
<CodeBlock title="rules" language="shell" code={rulesCommand} />

<h2>3. Validate changed files</h2>
<p>
  <code>--changed</code> uses Git-backed discovery to scope work to the current
  working tree.
</p>
<CodeBlock title="validate" language="shell" code={validateCommand} />

<h2>4. Read agent feedback</h2>
<p>
  The <code>feedback</code> command produces concise text designed to be fed
  back into an agent loop after edits.
</p>
<CodeBlock title="feedback" language="shell" code={feedbackCommand} />

<h2>5. Open the workbench</h2>
<p>
  The daemon serves a local UI for browsing rules beside code.
</p>
<CodeBlock title="workbench" language="shell" code={openCommand} />

<p>
  From here, read <a href="/docs/concepts">Concepts</a> for the model and
  <a href="/docs/validators">Validators</a> for adding rules.
</p>
