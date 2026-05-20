<script>
  import InfoTip from '$lib/components/InfoTip.svelte';
</script>

<svelte:head><title>Concepts | OpenCanon</title></svelte:head>

<h1>Concepts</h1>
<p class="lead">
  OpenCanon has four core objects and one daemon.
</p>

<h2>Docs</h2>
<p>
  Docs are normal Markdown headings referenced from decisions with
  <code>docs</code> refs such as <code>docs/opencanon/canon/architecture.md#imports</code>.
  <InfoTip term="canon" id="concept-canon-tip" /> Context queries reach prose
  through the decisions whose topics and applies globs match the work.
</p>

<h2>Decisions</h2>
<p>
  Decisions are structured records in <code>docs/opencanon/decisions.json</code>.
  <InfoTip term="decisions" id="concept-decisions-tip" /> Each decision explains
  a rule, its applicability, the docs headings it depends on, and the validators
  that enforce it.
</p>

<h2>Validators</h2>
<p>
  Validators are TypeScript functions. They read facts from the daemon and
  return findings. They can use graph facts for symbol search, callers,
  callees, references, and impact. Fixtures pin each validator's behavior.
</p>

<h2>Findings</h2>
<p>
  A finding is the unit of output. <InfoTip term="findings" id="concept-findings-tip" />
  It carries:
</p>
<ul>
  <li><code>rule</code>: the validator that produced it.</li>
  <li><code>severity</code>: <code>error</code> or <code>warn</code>.</li>
  <li><code>location</code>: file, line, and optional span.</li>
  <li><code>decision</code>: the decision the rule backs.</li>
  <li><code>fix</code>: optional structured edits or an advisory command.</li>
</ul>

<h2>Fix Plans</h2>
<p>
  Fix and refactor helpers are plan-first. Validators can attach structured
  edits, and the core <code>fixes</code> namespace can plan symbol renames, file
  moves, import updates, package renames, and module splits before anything is
  written.
</p>

<h2>Daemon</h2>
<p>
  The daemon watches the repository, extracts facts, stores SQLite state, and
  serves the local API used by CLI, hooks, and UI.
</p>

<h2>What OpenCanon is not</h2>
<ul>
  <li>It is not a linter. Validators read structured facts, not source text.</li>
  <li>It is not a CI service. The daemon runs locally next to the editor.</li>
  <li>It is not a rule DSL. Validators are TypeScript with fixtures.</li>
</ul>
