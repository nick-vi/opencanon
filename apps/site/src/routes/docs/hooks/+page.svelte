<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';

  const installCommands = `opencanon hook install --all --dry-run
opencanon hook install --all`;
</script>

<svelte:head><title>Hooks | OpenCanon</title></svelte:head>

<h1>Hooks</h1>
<p class="lead">
  Hooks connect agent write events to OpenCanon feedback. They call the runtime,
  then return scoped findings and next steps to the agent.
</p>

<h2>Supported hosts</h2>
<ul>
  <li>Claude Code: PostToolUse feedback hook.</li>
  <li>OpenCode: post-write feedback hook.</li>
  <li>Codex: PostToolUse feedback hook.</li>
</ul>

<h2>Install</h2>
<CodeBlock title="hook install" language="shell" code={installCommands} />
<p>
  <code>--dry-run</code> prints the planned configuration without writing.
</p>

<h2>What the agent sees</h2>
<p>
  Hooks return findings: rule, severity, location, Project Canon references,
  impacted surfaces, related Changes, and optional fix suggestions. The agent
  reads them as tool output.
</p>

<h2>Failure mode</h2>
<p>
  Hooks fail fast. If the service, project runtime, or engine is missing, the
  hook reports a diagnostic instead of doing a partial run.
</p>
