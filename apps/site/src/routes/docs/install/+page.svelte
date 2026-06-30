<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';
  import {
    INSTALL_COMMAND,
    RELEASE_MANIFEST_URL,
    SERVICE_COMMAND,
    SETUP_COMMAND,
    SITE,
    SKILLS_INSTALL_COMMAND
  } from '$lib/site.config.js';

  const releaseProducerCommand = `npm run release:publish -- 0.4.0`;
</script>

<svelte:head><title>Install | OpenCanon</title></svelte:head>

<h1>Install</h1>
<p class="lead">
  Install OpenCanon once, then set up each repository with Project Canon that is
  agent-ready, human-readable, and runtime-enforced.
</p>

<h2>Prerequisites</h2>
<ul>
  <li>
    Node <code>&gt;=24.12.0</code> for the installed CLI and local service.
  </li>
  <li>A Git repository (Git-backed discovery is the default).</li>
  <li>
    Optional agent host: Claude Code, OpenCode, Codex, or any MCP-capable tool.
  </li>
  <li>No repository dependency install is required just to use OpenCanon.</li>
</ul>

<h2>Install the runtime</h2>
<p>
  The installer fetches the signed runtime release for the current platform and
  makes the <code>opencanon</code> command available locally.
</p>
<CodeBlock title="install" language="shell" code={INSTALL_COMMAND} />
<p>
  Agent skills and entry files are guidance only. The installed runtime owns the
  CLI, local service, updater, project runtimes, engine, and local API.
</p>

<h2>Optional agent skill</h2>
<p>
  Agent hosts that support skills can install the OpenCanon skill for progressive
  workflow instructions. The skill points back to the live CLI instead of
  shipping its own implementation.
</p>
<CodeBlock title="agent skill" language="shell" code={SKILLS_INSTALL_COMMAND} />

<h2>Initialize a repository</h2>
<p>
  Run setup in the repository root. It creates source definitions, generated
  docs, fixtures, cache ignores, optional hooks, and an agent setup packet.
</p>
<p>
  Commit generated docs, Project Canon definitions under <code>opencanon/</code>,
  fixtures, hook config, managed agent guidance, and package script. Generated
  state under <code>.opencanon/</code> stays ignored.
</p>
<CodeBlock title="setup" language="shell" code={SETUP_COMMAND} />

<h2>Start the service</h2>
<p>
  The global service starts project runtimes lazily. Repo state lives under
  <code>.opencanon/</code> and is ignored by Git; the service registry lives
  under the OpenCanon home directory.
</p>
<CodeBlock title="service" language="shell" code={SERVICE_COMMAND} />

<h2>Runtime manifest</h2>
<p>
  Release installs use a manifest. Setup detects the current platform, selects
  the matching asset, verifies SHA-256, and writes runtime files atomically.
</p>
<CodeBlock
  title="manifest"
  language="shell"
  code={`opencanon update check --manifest ${RELEASE_MANIFEST_URL}`}
/>

<h2>Release producer flow</h2>
<p>
  Maintainers publish through one script so versions, release checks, tags,
  GitHub workflow watching, and asset verification stay coherent. The release
  workflow builds engine assets for every supported target and uploads the
  manifest, runtime archive, channel files, and checksums.
</p>
<CodeBlock title="publish release" language="shell" code={releaseProducerCommand} />

<h2>Next</h2>
<p>
  Continue with the <a href="/docs/quickstart">Quickstart</a> to load context,
  run Proof, and produce findings.
</p>
