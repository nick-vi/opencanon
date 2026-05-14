<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';

  const layoutTree = `.agents/skills/opencanon/
  scripts/opencanon.ts        # entrypoint, imports runtime/cli.js
  runtime/                    # bundled CLI, core APIs, validators,
                              # daemon, UI assets, engine binary
  index.ts                    # validator authoring barrel

docs/opencanon/
  decisions.json              # decisions register
  canon/*.md                  # normal Markdown headings linked from decisions

.opencanon/                   # per-repo state (gitignored)
~/.opencanon/daemons.json     # supervisor registry`;
</script>

<svelte:head><title>Architecture | OpenCanon</title></svelte:head>

<h1>Architecture</h1>
<p class="lead">
  OpenCanon is a daemon plus clients. The daemon owns state. The CLI, hooks,
  and UI present the same results.
</p>

<h2>Layout</h2>
<CodeBlock title="skill layout" language="tree" code={layoutTree} />

<h2>Boundaries</h2>
<ul>
  <li>
    <strong>Workspace packages</strong> are the development source for
    <code>@opencanon/cli</code>, <code>@opencanon/core</code>,
    <code>@opencanon/daemon</code>, <code>@opencanon/engine</code>,
    <code>@opencanon/ui</code>, and <code>@opencanon/validators</code>.
  </li>
  <li>
    <strong>The skill</strong> is self-contained. It ships the bundled runtime
    so consumers do not need workspace packages or npm install at install time.
    The bundled runtime is built for Bun.
  </li>
  <li>
    <strong>Repository validators</strong> import through
    <code>.agents/skills/opencanon/index.ts</code>, never workspace package
    names. That keeps validator code portable across host repositories.
  </li>
</ul>

<h2>Discovery</h2>
<p>
  Inside a Git repository, discovery is Git-backed. <code>.gitignore</code> is
  honored, then OpenCanon applies <code>projectFilePatterns</code>,
  <code>ignore</code>, <code>maxFiles</code>, and <code>maxFileSizeKb</code>.
  Filesystem discovery is available as an explicit override for tests and
  benchmarks; OpenCanon never silently falls back from Git to filesystem.
</p>

<h2>Strict prerequisites</h2>
<p>
  Daemon-backed commands are strict about prerequisites: Bun runtime version,
  the bundled engine binary, the configured cache directory, decisions, and
  referenced Markdown headings. Invalid configuration is a hard failure for normal
  <code>context</code> and <code>validate</code> commands; <code>doctor</code>
  reports the same diagnostics and offers safe fixes.
</p>
