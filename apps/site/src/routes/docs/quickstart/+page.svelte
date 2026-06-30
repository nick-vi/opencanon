<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';

  const contextCommand = `opencanon context --files src/services/company.service.ts`;
  const rulesCommand = `opencanon canon list conventions
opencanon rules --validator service-no-db-client
opencanon rules --convention service-db-boundary`;
  const validateCommand = `opencanon validate --changed
opencanon validate --changed --strict-warnings`;
  const feedbackCommand = `opencanon feedback --changed`;
  const openCommand = `opencanon service open
opencanon project open`;
</script>

<svelte:head><title>Quickstart | OpenCanon</title></svelte:head>

<h1>Quickstart</h1>
<p class="lead">
  Use the same agent-ready, human-readable Project Canon to load scoped context,
  validate a change, and return Proof to a human or agent loop.
</p>

<h2>1. Load context for a file</h2>
<p>
  Ask OpenCanon what applies to a file. It returns docs, conventions, validators,
  active Changes, impact surfaces, checks, and optional Git history.
</p>
<CodeBlock title="context" language="shell" code={contextCommand} />

<h2>2. List the rules in play</h2>
<CodeBlock title="rules" language="shell" code={rulesCommand} />

<h2>3. Run Proof on changed files</h2>
<p>
  <code>--changed</code> uses Git-backed discovery to scope work to the current
  working tree.
</p>
<CodeBlock title="validate" language="shell" code={validateCommand} />

<h2>4. Read feedback</h2>
<p>
  The <code>feedback</code> command produces concise text designed to be fed
  back into an agent loop after edits or reviewed directly by a human.
</p>
<CodeBlock title="feedback" language="shell" code={feedbackCommand} />

<h2>5. Open browser diagnostics</h2>
<p>
  The service and project runtime expose local browser URLs for inspecting
  Health and API responses while debugging.
</p>
<CodeBlock title="diagnostics" language="shell" code={openCommand} />

<p>
  From here, read <a href="/docs/concepts">Concepts</a> for the model and
  <a href="/docs/validators">Validators</a> for adding rules.
</p>
