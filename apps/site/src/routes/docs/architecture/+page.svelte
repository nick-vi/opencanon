<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';

const layoutTree = `opencanon/
├─ areas/
├─ changes/
├─ conventions/
├─ specs/
└─ fixtures/

docs/opencanon/
├─ areas/
├─ canon/
├─ changes/
├─ specs/
└─ impact-surfaces.json

.gitignore
.opencanon/
├─ state.sqlite
├─ cache/
└─ indexes/

~/.opencanon/
├─ service.json
└─ runtime/`;
</script>

<svelte:head><title>Architecture | OpenCanon</title></svelte:head>

<h1>Architecture</h1>
<p class="lead">
  OpenCanon is a local service, isolated project runtimes, typed Project Canon,
  and clients that share one versioned API for human-readable docs, agent-ready
  context, and runtime enforcement.
</p>

<h2>Layout</h2>
<CodeBlock title="project layout" language="tree" code={layoutTree} />

<h2>Boundaries</h2>
<ul>
  <li>
    <strong>Workspace packages</strong> are the development source for
    <code>@opencanon/cli</code>, <code>@opencanon/core</code>,
    <code>@opencanon/runtime</code>, <code>@opencanon/service-contracts</code>,
    <code>@opencanon/distribution</code>, <code>@opencanon/engine</code>,
    <code>@opencanon/observability</code>, and <code>@opencanon/validators</code>.
  </li>
  <li>
    <strong>The installed runtime</strong> owns the CLI, updater, local service,
    project runtimes, native engine, and local API. Agent skills and entry files
    are text guidance over that runtime.
  </li>
  <li>
    <strong>Repository definitions</strong> live in <code>opencanon/</code>.
    Generated Markdown is derived from those definitions and checked by Doctor
    for drift.
  </li>
</ul>

<h2>Discovery</h2>
<p>
  Inside a Git repository, discovery is Git-backed. <code>.gitignore</code> is
  honored, then OpenCanon applies <code>projectFilePatterns</code>,
  <code>ignore</code>, <code>maxFiles</code>, and <code>maxFileSizeKb</code>.
  Filesystem discovery is available as an explicit mode for tests and
  benchmarks; OpenCanon does not silently hide discovery failures.
</p>

<h2>Graph Index</h2>
<p>
  The engine extracts TS/JS symbols, references, calls, imports, literals,
  diagnostics, duplicates, and Python facts into local SQLite state. CLI graph
  commands and validators read the same index, so scoped searches,
  caller/callee inspection, and graph-backed validators share one source of
  repository facts. Rust crates, Cargo dependencies, npm dependencies, and
  Python dependency metadata are also discovered for generated authoring
  constants.
</p>

<h2>Generated authoring types</h2>
<p>
  The project runtime keeps gitignored authoring files fresh under
  <code>.opencanon/generated/</code>. Generated files expose typed constants for
  workspace packages, import specifiers, npm dependencies, Rust crates, Cargo
  dependencies, and Python dependencies. Fixture virtual projects can still be
  type-checked in an editor without committing generated state.
</p>
<p>
  These generated types are deliberately small. OpenCanon does not generate
  per-file symbol, literal, caller, or callee maps by default because those
  make TypeScript language servers slow in large repositories. Validators still
  read precise facts at runtime from <code>ctx.facts</code> and
  <code>ctx.graph</code>.
</p>

<h2>Strict prerequisites</h2>
<p>
  Runtime-backed commands are strict about prerequisites: Node version, installed
  runtime layout, native engine binary, configured cache directory, Project
  Canon source, generated docs, and referenced Markdown headings. Invalid
  configuration is a hard failure for normal <code>context</code> and
  <code>validate</code> commands; <code>doctor</code> reports the same
  diagnostics and offers safe fixes.
</p>
