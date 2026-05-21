<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';
  import {
    DAEMON_COMMAND,
    INIT_COMMAND,
    RELEASE_MANIFEST_URL,
    SKILL_COMMAND,
    SITE,
    SKILLS_INSTALL_COMMAND
  } from '$lib/site.config.js';
</script>

<svelte:head><title>Install | OpenCanon</title></svelte:head>

<h1>Install</h1>
<p class="lead">
  Add the OpenCanon skill, then let setup install the engine runtime for the
  current machine.
</p>

<h2>Prerequisites</h2>
<ul>
  <li>
    Bun <code>{SITE.bunVersion}</code> to execute the bundled CLI and daemon.
  </li>
  <li>A Git repository (Git-backed discovery is the default).</li>
  <li>
    An agent host with a skills directory: Claude Code, OpenCode, or Codex.
    Standalone CLI use without an agent host is also supported.
  </li>
  <li>No npm install is needed after cloning the skill.</li>
</ul>

<h2>Add the skill</h2>
<p>
  Use the skills.sh CLI to install the OpenCanon skill into the current
  repository.
</p>
<CodeBlock title="skills.sh" language="shell" code={SKILLS_INSTALL_COMMAND} />
<p>
  The installed skill bootstraps the CLI, validators, daemon, UI assets, and
  engine runtime from the signed release assets during setup. Bun is the
  runtime, not a package installation step.
</p>

<h2>Install engine runtime</h2>
<p>
  Release installs use a manifest. Setup detects the current platform, selects
  the matching engine asset, verifies SHA-256, and writes the binary into the
  skill runtime.
</p>
<CodeBlock
  title="setup with release manifest"
  language="shell"
  code={`${SKILL_COMMAND} setup --yes --hooks codex --manifest ${RELEASE_MANIFEST_URL}`}
/>

<h2>Initialize a repository</h2>
<p>
  Run setup in the repository root. It creates starter
  docs, decisions, validators, fixtures, cache ignores, and optional hooks.
</p>
<p>
  Commit the docs, decisions, validators, fixtures, hook config, skill wrapper
  files, the skill-local <code>.gitignore</code>, <code>skills-lock.json</code>,
  and package script. Runtime assets under
  <code>.agents/skills/opencanon/runtime/</code> are ignored by
  <code>.agents/skills/opencanon/.gitignore</code>. Generated state under
  <code>.opencanon/</code> is ignored by the root <code>.gitignore</code>.
</p>
<CodeBlock title="initialize" language="shell" code={INIT_COMMAND} />

<h2>Start the daemon</h2>
<p>
  The daemon runs per repository. Repo state lives under
  <code>.opencanon/</code> and is ignored by Git; the supervisor registry lives at
  <code>~/.opencanon/daemons.json</code>.
</p>
<CodeBlock title="daemon" language="shell" code={DAEMON_COMMAND} />

<h2>Next</h2>
<p>
  Continue with the <a href="/docs/quickstart">Quickstart</a> to load context,
  run validators, and produce findings.
</p>
