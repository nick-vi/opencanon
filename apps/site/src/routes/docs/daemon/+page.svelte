<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';

  const lifecycleCommands = `opencanon daemon start       # background
opencanon daemon serve       # foreground
opencanon daemon status
opencanon daemon list        # all registered daemons
opencanon daemon stop
opencanon daemon check       # prerequisites only`;

  const updateCommands = `opencanon update check --manifest ./opencanon-runtime-manifest.json
opencanon daemon stop
opencanon update apply --manifest ./opencanon-runtime-manifest.json
opencanon daemon check
opencanon daemon start`;
</script>

<svelte:head><title>Daemon | OpenCanon</title></svelte:head>

<h1>Daemon</h1>
<p class="lead">
  The daemon watches one repository, caches facts, and serves the local API.
</p>

<h2>Runtime</h2>
<p>
  The bundled daemon runs on Bun. The skill ships built JavaScript,
  UI assets, validators, and the engine runtime, so consumers do not install
  workspace packages to run it.
</p>

<h2>Lifecycle</h2>
<CodeBlock title="daemon lifecycle" language="shell" code={lifecycleCommands} />

<h2>State</h2>
<p>
  Repo state lives under <code>.opencanon/</code>. The supervisor registry lives
  in <code>~/.opencanon/daemons.json</code>. Parser caches belong in Git ignore;
  <code>doctor --fix safe</code> can add the ignore entry.
</p>

<h2>Engine Runtime</h2>
<p>
  The daemon uses the engine binary under
  <code>.agents/skills/opencanon/runtime/engine/</code> for watching, hashing,
  fact extraction, and affected-file calculation. JavaScript and TypeScript use
  Oxc.
</p>

<h2>Updates</h2>
<p>
  Runtime updates are manifest-driven. The CLI selects the current target,
  verifies Bun and schema compatibility, checks the asset hash, and refuses to
  write while the daemon is running.
</p>
<CodeBlock title="runtime update" language="shell" code={updateCommands} />

<h2>API</h2>
<p>
  The daemon exposes a JSON API over a local Unix socket. The CLI, hooks, and UI
  use the same endpoints.
</p>
