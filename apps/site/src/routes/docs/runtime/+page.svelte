<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';

  const serviceCommands = `opencanon status
opencanon service start
opencanon service status --format json
opencanon service open`;

  const projectCommands = `opencanon project check
opencanon project status --format json
opencanon project index
opencanon project logs --tail 200
opencanon project open
opencanon project stop
opencanon project start --foreground`;

  const updateCommands = `opencanon service stop
opencanon project stop
opencanon update check --manifest ./opencanon-runtime-manifest.json
opencanon update apply --manifest ./opencanon-runtime-manifest.json
opencanon doctor --fix`;
</script>

<svelte:head><title>Runtime | OpenCanon</title></svelte:head>

<h1>Runtime</h1>
<p class="lead">
  OpenCanon runs as a local service plus isolated project runtimes. The CLI,
  MCP, hooks, and browser diagnostics all read the same local API.
</p>

<h2>Service</h2>
<p>
  The global service discovers OpenCanon projects, owns the cross-project
  registry, and lazily starts project runtimes when a command needs repository
  data.
</p>
<CodeBlock title="service" language="shell" code={serviceCommands} />

<h2>Project runtime</h2>
<p>
  A project runtime owns one repository. It indexes source files, generates
  authoring types, stores derived SQLite state, tracks Activity, serves Search,
  and runs Proof against scoped files or the whole project.
</p>
<CodeBlock title="project runtime" language="shell" code={projectCommands} />

<h2>State</h2>
<p>
  Committed Project Canon lives under <code>opencanon/</code> and generated
  docs live under <code>docs/opencanon/</code>. Derived state lives under
  <code>.opencanon/</code> and stays ignored by Git. The OpenCanon home
  directory stores service registry and installed runtime metadata.
</p>

<h2>Engine</h2>
<p>
  The native engine handles watching, hashing, fact extraction, code graph
  indexing, and affected-file calculation. JavaScript and TypeScript facts,
  Python facts, dependency metadata, semantic chunks, and generated project
  constants are all runtime-derived.
</p>

<h2>Updates</h2>
<p>
  Runtime updates are manifest-driven. The CLI selects the current target,
  checks schema and Node compatibility, verifies asset hashes, and refuses to
  write while the service or current project runtime is running. Runtime updates
  do not mutate project files directly; Doctor owns managed project artifact
  repair through <code>opencanon doctor --fix</code>.
</p>
<CodeBlock title="runtime update" language="shell" code={updateCommands} />

<h2>API</h2>
<p>
  The service exposes project discovery and project-runtime proxy endpoints.
  Project runtimes expose Project Canon, Proof, Knowledge, Activity, Health,
  file, graph, and context endpoints for local clients.
</p>
