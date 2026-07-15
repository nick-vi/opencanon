# OpenCanon

OpenCanon keeps a repository's engineering rules, specs, active work, and project knowledge in one enforced Project Canon.

It is agent-ready, human-readable, runtime-enforced local infrastructure. Humans can inspect the canon through CLI and browser diagnostics; agents can load scoped context, follow active Changes, and prove work with validators, checks, Doctor, and generated-doc drift checks. The same typed definitions feed the CLI, managed agent guidance, editor hooks, local service, project runtimes, MCP, and CI.

Website: https://opencanon.dev/

## Setup

Install OpenCanon first so the `opencanon` CLI is available. Then run setup in the repository; OpenCanon initializes the scaffold and emits an agent setup packet for establishing Project Canon:

```bash
curl -fsSL https://github.com/nick-vi/opencanon/releases/latest/download/opencanon-install.mjs -o opencanon-install.mjs
node opencanon-install.mjs
rm opencanon-install.mjs
opencanon setup --yes --hooks codex
```

The managed skill and agent entry files are text-only: they teach agents the workflow, but the installed OpenCanon runtime owns the CLI, global service, project runtimes, updater, engine, and local API. `setup` is safe to rerun. It runs deterministic init, scaffolds missing OpenCanon files, installs requested feedback hooks, validates convention context, runs doctor checks, runs project validation, verifies runtime prerequisites, and starts the project runtime unless `--no-runtime` is used. Use `init` directly only when you want the lower-level deterministic scaffold without the agent setup packet.

Commit the scaffolded generated docs, definition source under `opencanon/`, fixtures, hook config, managed agent guidance under `.agents/`, and package script. Do not commit `.opencanon/` generated state.

## Daily Use

```bash
opencanon brief --format json
opencanon context --files src/services/company.service.ts
opencanon canon list areas
opencanon changes list
opencanon changes check <change-id> --task <task-id> --all
opencanon changes check <change-id> <check-id> --task <task-id>
opencanon changes runs list --status running
opencanon changes runs watch <run-id> --after <sequence>
opencanon rules --convention service-db-boundary
opencanon rules --validator service-no-db-client
opencanon search loadCompany
opencanon context status
opencanon project index
opencanon ask "where is billing enforced?"
opencanon symbols loadCompany --kind function --scope "src/services/**"
opencanon graph callers loadCompany
opencanon validate --changed
opencanon gate pending --format json
opencanon gate approve <gate-id> --summary "User confirmed the change is intended."
opencanon feedback --changed
opencanon doctor
opencanon mcp --root .
```

- `context` loads relevant Project Canon, proof checks, knowledge evidence, impact context, and optional git history for files or topics.
- `canon` lists, renders, drafts, and inspects Project Canon definitions across conventions, areas, specs, and changes.
- `changes` is the CLI command for Change definitions and execution: it lists active work, records SQLite-backed Activity, runs declared checks, and can list, inspect, resume, or cancel persisted runs after the initiating client exits.
- `rules` lists convention summaries, scopes, render targets, runtime checks, and fixture coverage.
- `search` searches symbols, conventions, checks, docs, and ready Project Knowledge. `ask` queries Project Knowledge with cited evidence. Use `opencanon context status` to inspect readiness and `opencanon project index` to build or refresh Search, Ask, Chunks, and Coverage.
- `symbols` and `graph` inspect the local TS/JS code graph before edits or refactors.
- `validate` runs convention runtimes against files, changed files, fixtures, or the whole project.
- `feedback` renders concise findings plus related changes, affected areas, impact surfaces, and scope drift.
- `doctor` checks setup, effective config, Project Canon, generated docs, dependency pins, hooks, runtime prerequisites, generated artifact ignores, Project Knowledge, and external tool declarations.
- `mcp` starts a stdio MCP server over the same runtime-backed model for agent clients.

Run `npm run opencanon -- <command> --help` for command-specific options.

## Runtime

Project-backed commands require Node `24.12.0` and the installed OpenCanon runtime bundle.

```bash
opencanon status
opencanon status --format json
opencanon project check
opencanon service status
opencanon service status --format json
opencanon service start
opencanon service open
opencanon project status
opencanon project status --format json
opencanon project list
opencanon project index
opencanon project logs --tail 200
opencanon project open
opencanon project stop
opencanon project start --foreground
```

OpenCanon uses one lightweight service per runtime namespace, registered under `~/.opencanon/namespaces/<namespace>/service.json`. Installed builds use the stable namespace; source checkouts use deterministic development namespaces so they can coexist safely. A service discovers OpenCanon projects, lazily starts isolated per-project runtimes, and lists its registered runtimes. Each project runtime keeps its own `.opencanon/state/<namespace>/state.sqlite`, vector state, process state, auth token, live refresh state, generated project types, and idle timeout. Registry entries advertise both a local pipe endpoint and a loopback browser URL; CLI, MCP, and runtime clients prefer the pipe endpoint, while URLs remain available for browser diagnostics.

`opencanon service open` opens the local service API URL. `opencanon project open` opens the current project's runtime API URL.

Normal `context`, `search`, `ask`, `validate`, `feedback`, hook, and workbench commands reuse a running project runtime or ask the service to start one. Project start is intentionally cheap: it opens the local API, refreshes deterministic project state on demand, and reads cached Project Knowledge state. Search, Ask, Chunks, and Coverage fail fast when Project Knowledge is missing, stale, failed, or still indexing; run `opencanon project index` to explicitly build native semantic vectors. Programmatic API callers can opt into that cost with `index=1` on semantic retrieval routes. Project-local generated state remains under `.opencanon/` and is ignored by Git, including SQLite state and Knowledge vector files. `project start --foreground` runs this project runtime in the foreground for local runtime debugging.

## Runtime Updates

Installation and updates are manifest-driven for the installed OpenCanon runtime. The CLI detects the current target from `process.platform` and `process.arch`, selects that target in the manifest, verifies the downloaded asset SHA-256, and writes the runtime bundle atomically.

Minimal manifest shape:

```json
{
  "version": 1,
  "channel": "stable",
  "runtimeVersion": "0.4.6",
  "requiredNode": ">=24.12.0",
  "bundles": {
    "darwin-arm64": {
      "url": "./opencanon-runtime-darwin-arm64.tar.gz",
      "sha256": "<64 hex chars>"
    }
  }
}
```

```bash
npm run opencanon -- update check
npm run opencanon -- update apply
npm run opencanon -- update check --manifest ./opencanon-runtime-manifest.json
npm run opencanon -- update apply --manifest ./opencanon-runtime-manifest.json
OPENCANON_UPDATE_MANIFEST=https://example.com/opencanon-runtime-manifest.json npm run opencanon -- update check
```

When no manifest is passed, update commands use the latest signed stable manifest published on GitHub Releases. `update apply` refuses to write while the OpenCanon service or any registered project runtime is running. Stop the service first, confirm `opencanon project list` is clear, apply the runtime update, then run `opencanon doctor --fix` inside initialized projects to refresh managed agent guidance and setup artifacts. The service can start project runtimes lazily on the next command.

Remote HTTPS manifests must carry a valid Ed25519 signature. Local `file:` or path manifests are operator-provided and exempt for development, tests, and install rehearsal. See [docs/runtime-update-security.md](docs/runtime-update-security.md) for the trust chain and rotation runbook.

## Config

`opencanon.config.json` is optional. Defaults are:

- docs: `docs/opencanon`
- conventions: `opencanon/conventions/index.ts`
- areas: `opencanon/areas/index.ts`
- changes: `opencanon/changes/index.ts`
- fixtures: `opencanon/fixtures`
- impact surfaces: `docs/opencanon/impact-surfaces.json`
- proposed impact notes: `docs/opencanon/proposed-impact-notes.json`
- baseline: `.opencanon/baseline.json`
- cache: `.opencanon/cache`
- project files: root `src/**`, `tests/**`, common `apps/*` and `packages/*`, plus roots from `package.json#workspaces`
- discovery: Git-backed inside Git repos, filesystem-backed outside Git repos

Add `opencanon.config.json` only when a repository needs to override those defaults.

```json
{
  "docsDir": "docs/opencanon",
  "conventionsPath": "opencanon/conventions/index.ts",
  "areasPath": "opencanon/areas/index.ts",
  "changesPath": "opencanon/changes/index.ts",
  "fixturesDir": "opencanon/fixtures",
  "impactSurfacesPath": "docs/opencanon/impact-surfaces.json",
  "proposedImpactNotesPath": "docs/opencanon/proposed-impact-notes.json",
  "baselinePath": ".opencanon/baseline.json",
  "commitApprovalsPath": ".opencanon/commit-approvals.json",
  "commitApprovalsPersistent": false,
  "cacheDir": ".opencanon/cache",
  "fileDiscovery": "git",
  "maxFiles": 20000,
  "maxFileSizeKb": 512,
  "projectFilePatterns": ["src/**/*.{ts,tsx,js,jsx,py,rs,svelte,css,json,md}", "tests/**/*.{ts,tsx,js,jsx,py,rs,svelte,css,json,md}"],
  "ignore": ["node_modules/**", ".git/**", ".agents/**", ".opencanon/**"],
  "entrypoints": ["src/main.ts"],
  "publicSurfaces": ["src/api/**"],
  "generated": ["src/generated/**"],
  "externalTools": {
    "semgrep": {
      "command": "semgrep",
      "versionArgs": ["--version"],
      "missingSeverity": "warning",
      "timeoutMs": 5000
    }
  }
}
```

When discovery is `git`, OpenCanon requires a Git repository and never silently falls back to filesystem traversal. Git discovery respects `.gitignore`, then OpenCanon applies `projectFilePatterns`, `ignore`, `maxFiles`, and `maxFileSizeKb`.

Commit gates are convention-owned approval checkpoints for ambiguous changes. A runtime can call `ctx.commitGate(...)`; unresolved gates block `validate --changed` until `opencanon gate approve <gate-id> --summary "<explicit user approval>" --via agent` records scoped approval. Pending gates are written to `.opencanon/cache/commit-gates.json`.

## Convention Contract

Conventions live at the configured `conventionsPath`, normally `opencanon/conventions/index.ts`. Export one convention or an array. Import `defineConvention` from `@opencanon/core`, curated factories from `@opencanon/validators`, and generated package/import constants from `@opencanon/project`.

```ts
import { defineConvention } from "@opencanon/core";

export default defineConvention({
  id: "service-db-boundary",
  title: "Services compose DAL instead of direct DB clients",
  rule: "Services own workflow composition and use DAL modules for persistence details.",
  topics: ["service", "dal"],
  applies: { kind: "files", globs: ["src/services/**/*.{ts,tsx}"] },
  render: { kind: "generated", docs: "docs/opencanon/canon/service-db-boundary.md", style: "reference" },
  runtime: {
    kind: "validator",
    severity: "error",
    scope: "import-edge",
    facts: ["imports"],
    validate({ ctx }) {
      return ctx.facts.imports()
        .filter((edge) => edge.from.path.includes("/services/"))
        .filter((edge) => edge.source.endsWith("/db/client"))
        .map((edge) =>
          edge.from.report({
            line: edge.line,
            message: "Services must call DAL functions instead of importing DB clients directly.",
          }),
        );
    },
  },
});
```

Use `render: { kind: "generated", docs: "...", style: "reference" }` when OpenCanon should own a rendered page. Use `render: { kind: "none" }` when a definition should have no generated docs. Use `runtime: { kind: "none" }` for narrative-only conventions and `runtime: { kind: "validator", ... }` for enforced checks.

Runtime conventions should have:

- a kebab-case `id`
- `title`, `rule`, and `topics`
- `applies` as `{ kind: "files", globs: [...] }`, `{ kind: "imports", from: [...] }`, `{ kind: "packages", names: [...] }`, or `{ kind: "project" }`
- a `render` mode
- a `runtime` mode
- focused fixtures under `opencanon/fixtures/<convention-id>/`

Curated convention factories are optional imports and are never auto-enabled:

```ts
import { fileNames, noImports } from "@opencanon/validators";

export default [
  fileNames({
    id: "service-file-names",
    topics: ["service"],
    severity: "error",
    in: ["src/services/**/*.{ts,tsx}"],
    suffix: ".service.ts",
    allowNames: ["index.ts"],
    message: "Service files must use *.service.ts.",
  }),
  noImports({
    id: "no-route-dal-import",
    topics: ["api-route"],
    severity: "error",
    from: ["src/api/routes/**/*.{ts,tsx}"],
    to: ["src/db/dal/**/*.{ts,tsx}"],
    message: "Route handlers must call services, not DAL modules.",
  }),
];
```

Prefer `ctx.facts.*` for imports, exports, symbols, calls, literals, comments, references, annotations, diagnostics, and duplicates. Use `ctx.graph.*` for callers, callees, symbol references, and impact edges. Use `ctx.impact.*` for configured impact surfaces and proposed impact notes. Use `ctx.baseline.*` for known findings.

## Area And Change Contracts

Areas live at the configured `areasPath`, normally `opencanon/areas/index.ts`. They describe durable product or business behavior and link that behavior to files, docs, routes, commands, checks, impact surfaces, and governing conventions.

```ts
import { DefinitionTargetKind, defineArea } from "@opencanon/core";

export default defineArea({
  id: "project-health",
  title: "Project Health",
  summary: "Users can inspect project health through Doctor, CLI, and runtime APIs.",
  owns: [
    { kind: DefinitionTargetKind.File, path: "packages/core/src/doctor.ts" },
    { kind: DefinitionTargetKind.File, path: "packages/runtime/src/routes.ts" },
    { kind: DefinitionTargetKind.Doc, path: "docs/opencanon/areas/project-health.md" },
  ],
  checks: [{ id: "project-doctor", kind: "doctor" }],
  render: { kind: "generated", docs: "docs/opencanon/areas/project-health.md", style: "reference" },
});
```

Changes live at the configured `changesPath`, normally `opencanon/changes/index.ts`. They describe active planned change. Runtime progress, check results, and board status are stored as SQLite events, not committed status fields.

```ts
import { DefinitionTargetKind, defineChange } from "@opencanon/core";

export default defineChange({
  id: "add-project-health-api",
  title: "Add Project Health API",
  kind: "feature",
  intent: {
    problem: "Doctor is only visible through direct CLI invocation.",
    outcome: "Agents and browser diagnostics can inspect health through the runtime API.",
  },
  updates: { areas: ["project-health"] },
  scope: [{ kind: DefinitionTargetKind.File, path: "packages/runtime/src/routes.ts" }],
  checks: [{ id: "project-doctor", kind: "doctor" }],
  render: { kind: "generated", docs: "docs/opencanon/changes/add-project-health-api.md", style: "reference" },
});
```

OpenCanon-owned Markdown is always rendered from these definitions. Use `render: { kind: "none" }` when a definition should not produce generated docs; authored Markdown should not masquerade as an OpenCanon-owned definition doc.

## Fixtures

Convention runtime behavior is tested with fixtures:

- `opencanon/fixtures/<convention-id>/valid.ts`
- `opencanon/fixtures/<convention-id>/invalid.ts`
- optional `opencanon/fixtures/<convention-id>/fixed.ts` when structured fixes are provided

```bash
npm run opencanon -- validate --check-fixtures --validator <convention-id>
npm run opencanon -- validate --check-fixtures
```

Fixture files are virtual project definitions. Import `defineFixture` from `@opencanon/core/testing`, and prefer helpers such as `file.ts`, `file.tsx`, `file.py`, `file.rs`, `file.toml`, `file.md`, and `file.json`.

## Hooks

OpenCanon exposes the same validation result through manual feedback and host hook adapters:

```bash
npm run opencanon -- feedback --files src/services/company.service.ts
npm run opencanon -- feedback --changed
npm run opencanon -- hook codex < hook-payload.json
npm run opencanon -- hook claude < hook-payload.json
npm run opencanon -- hook opencode < hook-payload.json
```

`feedback` is for on-demand use. `hook` adapts host JSON payloads to OpenCanon feedback. Hook output is grouped by file, capped to a host-friendly budget, and includes the exact `opencanon validate --files ...` command for the full report.

## Project Authoring

`setup` runs init to generate convention authoring files once, and the project runtime keeps them fresh under `.opencanon/generated/authoring/` as dependency manifests, config files, and fixtures change. `project.ts` exposes typed constants for workspace packages, import specifiers, npm dependencies, Rust crates, Cargo dependencies, and Python dependencies. `aliases.d.ts` declares ambient modules for fixture imports. `core.d.ts`, `testing.d.ts`, and `validators.d.ts` provide self-contained authoring contracts so conventions and fixtures type-check without installing OpenCanon packages into the target repository.

```bash
npm run opencanon -- setup --yes
npm run opencanon -- project status
npm run opencanon -- project status --format json
```

Generated project types are deliberately small. OpenCanon does not generate huge symbol, literal, caller, or callee maps by default because those slow TypeScript language servers in large repositories; precise facts stay in the runtime index.
