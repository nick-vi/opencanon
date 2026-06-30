<script>
  import InfoTip from '$lib/components/InfoTip.svelte';
</script>

<svelte:head><title>Concepts | OpenCanon</title></svelte:head>

<h1>Concepts</h1>
<p class="lead">
  OpenCanon makes Project Canon agent-ready, human-readable, and
  runtime-enforced through Proof, Knowledge, Activity, and Health.
</p>

<h2>Project Canon</h2>
<p>
  Project Canon is the typed source of truth for a repository. <InfoTip term="canon" id="concept-canon-tip" />
  It contains Areas, Specs, Changes, conventions, impact surfaces, generated
  docs, and checks. Humans read the generated docs; agents query the richer
  source model through CLI or MCP.
</p>

<h2>Areas</h2>
<p>
  Areas describe durable ownership: product surfaces, architectural boundaries,
  runtime subsystems, or examples that have clear behavior and checks.
</p>

<h2>Specs</h2>
<p>
  Specs describe durable behavior with scope, scenarios, governing conventions,
  and checks. <InfoTip term="specs" id="concept-specs-tip" /> A completed Change
  can become or update a Spec when the behavior should be permanent.
</p>

<h2>Changes</h2>
<p>
  Changes describe active implementation plans. <InfoTip term="changes" id="concept-changes-tip" />
  They connect tasks to files, impact surfaces, checks, and the Project Canon
  that should guide the work.
</p>

<h2>Conventions</h2>
<p>
  Conventions explain repeatable rules. They can render docs, enforce runtime
  validators or gates, or simply document a human rule when runtime enforcement
  is not useful.
</p>

<h2>Proof</h2>
<p>
  Proof is the umbrella for validators, gates, fixtures, Doctor, declared task
  checks, and generated-doc drift checks. Validators read project facts and
  return findings. <InfoTip term="validators" id="concept-validators-tip" />
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
  <li><code>docs</code>: the Project Canon docs or definitions the finding backs.</li>
  <li><code>fix</code>: optional structured edits or an advisory command.</li>
</ul>

<h2>Fix Plans</h2>
<p>
  Fix and refactor helpers are plan-first. Validators can attach structured
  edits, and the core <code>fixes</code> namespace can plan symbol renames, file
  moves, import updates, package renames, and module splits before anything is
  written.
</p>

<h2>Knowledge</h2>
<p>
  Knowledge is the local index for files, docs, symbols, graph edges, chunks,
  backlinks, and related-code search. It helps humans and agents find evidence,
  but durable rules still live in Project Canon and Proof.
</p>

<h2>Activity</h2>
<p>
  Activity records indexing progress, agent work, check results, events, and
  logs as derived state. It helps explain what happened without becoming source
  truth.
</p>

<h2>Health</h2>
<p>
  Health covers setup, runtime prerequisites, generated-state freshness, hooks,
  dependency pins, and Doctor checks.
</p>

<h2>Runtime</h2>
<p>
  The local service watches repositories, starts project runtimes, extracts
  facts, stores SQLite state, and serves CLI, MCP, hooks, and browser
  diagnostics. <InfoTip term="runtime" id="concept-runtime-tip" />
</p>

<h2>What OpenCanon is not</h2>
<ul>
  <li>It is not a linter. Validators read structured facts, not source text.</li>
  <li>It is not a CI service. The service runs locally next to the editor.</li>
  <li>It is not a rule DSL. Validators are TypeScript with fixtures.</li>
</ul>
