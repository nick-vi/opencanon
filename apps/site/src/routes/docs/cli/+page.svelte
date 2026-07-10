<script>
  import CodeBlock from '$lib/components/CodeBlock.svelte';

  const contextCommands = `opencanon context --files src/services/company.service.ts
opencanon context --list-exceptions`;
  const canonCommands = `opencanon canon list areas
opencanon canon list specs
opencanon changes list`;
  const rulesCommands = `opencanon rules --validator service-no-db-client
opencanon rules --convention service-db-boundary
opencanon rules --tree --validator service-no-db-client`;
  const graphCommands = `opencanon search loadCompany --kind symbol --symbol-kind function --scope "src/services/**"
opencanon symbols loadCompany --kind function --scope "src/services/**"
opencanon graph callers loadCompany
opencanon graph callees loadCompany
opencanon refactor rename-symbol loadCompany fetchCompany --file src/services/company.service.ts --format json`;
  const validateCommands = `opencanon validate --changed
opencanon validate --project --profile
opencanon validate --check-fixtures
opencanon validate --changed --strict-warnings`;
  const gateCommands = `opencanon gate pending --format json
opencanon gate approve <gate-id> \\
  --summary "User explicitly approved the blocked change." \\
  --via agent`;
  const feedbackCommands = `opencanon feedback --changed
opencanon feedback --changed --strict-warnings`;
  const runtimeCommands = `opencanon service start
opencanon service status
opencanon project status
opencanon project index
opencanon project logs --tail 200
opencanon project stop`;
  const diagnosticCommands = `opencanon doctor
opencanon benchmark --sizes 1000,10000,50000 --source-snapshot`;
  const updateCommands = `opencanon update check --manifest ./opencanon-runtime-manifest.json
opencanon update apply --manifest ./opencanon-runtime-manifest.json --dry-run`;
  const baselineCommands = `opencanon baseline check
opencanon baseline update`;
  const stateCommands = `opencanon state status
opencanon state reset --confirm`;
</script>

<svelte:head><title>CLI | OpenCanon</title></svelte:head>

<h1>CLI</h1>
<p class="lead">
  The <code>opencanon</code> binary is the primary product surface. It talks to
  the local service, starts project runtimes on demand, and exposes the same
  model to humans, hooks, MCP, and CI.
</p>

<h2>Context</h2>
<CodeBlock title="context" language="shell" code={contextCommands} />
<p>
  Loads scoped Project Canon, Proof checks, Knowledge evidence, impact context,
  and optional Git history for files or topics.
</p>

<h2>Project Canon</h2>
<CodeBlock title="canon" language="shell" code={canonCommands} />
<p>
  Lists durable Areas and Specs plus active Changes that agents can follow.
</p>

<h2>Rules</h2>
<CodeBlock title="rules" language="shell" code={rulesCommands} />
<p>
  Lists convention summaries, scopes, generated docs, runtime checks, and
  fixture coverage.
  <code>--tree</code> shows the file scope.
</p>

<h2>Graph Search</h2>
<CodeBlock title="graph-search" language="shell" code={graphCommands} />
<p>
  Searches the indexed TS/JS graph, filters symbols by kind and file scope, and
  inspects caller/callee edges before a change or refactor.
</p>

<h2>Validate</h2>
<CodeBlock title="validate" language="shell" code={validateCommands} />

<h2>Commit Gates</h2>
<CodeBlock title="gate" language="shell" code={gateCommands} />
<p>
  Validators can emit commit gates for intent-sensitive changes. Pending gates
  are written during changed-file validation. Agents should inspect the staged
  diff and gate evidence, ask the user for explicit Approve or Reject, and only
  then record the scoped approval before retrying the commit.
</p>

<h2>Feedback</h2>
<CodeBlock title="feedback" language="shell" code={feedbackCommands} />
<p>
  Writes concise findings for an agent after edits.
</p>

<h2>Runtime</h2>
<CodeBlock title="runtime" language="shell" code={runtimeCommands} />

<h2>Runtime Updates</h2>
<CodeBlock title="update" language="shell" code={updateCommands} />
<p>
  Updates read a manifest, select the current engine target, and verify
  checksums before writing runtime assets. Writes fail while the service or
  current project runtime is running. After a real install, run
  <code>opencanon doctor --fix</code> in initialized projects to refresh managed
  agent guidance and setup artifacts.
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
<CodeBlock title="state" language="shell" code={stateCommands} />
