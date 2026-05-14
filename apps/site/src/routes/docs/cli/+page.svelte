<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';

  const contextCommands = `opencanon context --files src/services/company.service.ts
opencanon context --list-exceptions`;
  const rulesCommands = `opencanon rules --validator service-no-db-client
opencanon rules --decision service-db-boundary
opencanon rules --tree --validator service-no-db-client`;
  const validateCommands = `opencanon validate --changed
opencanon validate --project --profile
opencanon validate --check-fixtures
opencanon validate --changed --strict-warnings`;
  const feedbackCommands = `opencanon feedback --changed
opencanon feedback --changed --strict-warnings`;
  const daemonCommands = `opencanon daemon start
opencanon daemon status
opencanon daemon list
opencanon daemon open
opencanon daemon stop
opencanon daemon check`;
  const diagnosticCommands = `opencanon doctor
opencanon benchmark --sizes 1000,10000,50000`;
  const bundleCommands = `opencanon bundle inspect ./opencanon.bundle.ts
opencanon bundle plan ./opencanon.bundle.ts --option sourceRoot=src
opencanon bundle install ./opencanon.bundle.ts --option sourceRoot=src`;
  const updateCommands = `opencanon update check --manifest ./opencanon-runtime-manifest.json
opencanon update apply --manifest ./opencanon-runtime-manifest.json --dry-run`;
  const baselineCommands = `opencanon baseline check
opencanon baseline update`;
  const stateCommands = `opencanon db status
opencanon db reset --confirm`;
</script>

<svelte:head><title>CLI | OpenCanon</title></svelte:head>

<h1>CLI</h1>
<p class="lead">
  The <code>opencanon</code> binary talks to the daemon. If no daemon is running,
  it can start one for a single request.
</p>

<h2>Context</h2>
<CodeBlock title="context" language="shell" code={contextCommands} />
<p>
  Loads docs, decisions, validators, and optional Git history for files or
  topics.
</p>

<h2>Rules</h2>
<CodeBlock title="rules" language="shell" code={rulesCommands} />
<p>
  Lists validator summaries, scopes, decisions, and fixture coverage.
  <code>--tree</code> shows the file scope.
</p>

<h2>Validate</h2>
<CodeBlock title="validate" language="shell" code={validateCommands} />

<h2>Feedback</h2>
<CodeBlock title="feedback" language="shell" code={feedbackCommands} />
<p>
  Writes concise findings for an agent after edits.
</p>

<h2>Daemon</h2>
<CodeBlock title="daemon" language="shell" code={daemonCommands} />

<h2>Bundles</h2>
<CodeBlock title="bundle" language="shell" code={bundleCommands} />
<p>
  Bundles inspect, plan, and install docs, decisions, validators, impact
  surfaces, external tool declarations, and owned files.
</p>

<h2>Runtime Updates</h2>
<CodeBlock title="update" language="shell" code={updateCommands} />
<p>
  Updates read a manifest, select the current engine target, and verify
  checksums before writing runtime assets.
</p>

<h2>Baselines</h2>
<CodeBlock title="baseline" language="shell" code={baselineCommands} />
<p>
  Baselines record known findings so validators can distinguish existing debt
  from new drift.
</p>

<h2>Diagnostics</h2>
<CodeBlock title="diagnostics" language="shell" code={diagnosticCommands} />

<h2>Local State</h2>
<CodeBlock title="db" language="shell" code={stateCommands} />
