# OpenCanon

OpenCanon keeps AI-agent code changes aligned with repository conventions. It uses scoped docs, decision records, validators, findings, and local health checks.

Website: https://opencanon.dev/

## Setup

```bash
npx skills add nick-vi/opencanon --skill opencanon -a codex -y
bun .agents/skills/opencanon/scripts/opencanon.ts setup --yes --hooks codex
```

`setup` is safe to rerun. It scaffolds missing OpenCanon files, installs requested feedback hooks, validates the context, runs doctor checks, runs project validation, verifies daemon prerequisites, and starts the project daemon unless `--no-daemon` is used.

Commit the scaffolded docs, decisions, validators, fixtures, hook config, skill wrapper files, `.agents/skills/opencanon/.gitignore`, `skills-lock.json`, and package script. Do not commit `.agents/skills/opencanon/runtime/` or `.opencanon/` generated state; setup installs runtime assets locally from the release manifest, adds repo state paths to the root `.gitignore`, and keeps runtime ignored from the skill folder.

## Daily Use

```bash
bun run opencanon context --files src/services/company.service.ts
bun run opencanon rules --validator service-no-db-client
bun run opencanon search loadCompany
bun run opencanon search loadCompany --kind symbol --symbol-kind function --scope "src/services/**"
bun run opencanon symbols loadCompany --kind function --scope "src/services/**"
bun run opencanon graph callers loadCompany
bun run opencanon validate --changed
bun run opencanon feedback --changed
bun run opencanon doctor
```

- `context` loads the docs, decisions, validators, and optional git history relevant to files or topics.
- `rules` lists validator summaries, scopes, decisions, and fixture coverage.
- `search` searches symbols, decisions, validators, and docs with deterministic fuzzy matching; symbol searches can be narrowed by symbol kind and path scope.
- `symbols` searches the local TS/JS code graph and supports path scopes for boundary-focused function lists.
- `graph` inspects deterministic caller, callee, and impact edges.
- `validate` runs validators against files, changed files, fixtures, or the whole project.
- `feedback` runs validators and renders concise text intended to be fed back into an agent after edits.
- `doctor` checks setup, effective config, validator coverage, dependency pins, hooks, daemon runtime prerequisites, generated artifact ignore rules, and external tool declarations.

Run `bun run opencanon <command> --help` for command-specific options.

## Bundle Install

Bundles install or enrich docs, decisions, validators, impact surfaces, external tool config, and bundle-owned files.

```bash
bun run opencanon bundle inspect ./opencanon.bundle.ts
bun run opencanon bundle list
bun run opencanon bundle plan ./opencanon.bundle.ts --option sourceRoot=src
bun run opencanon bundle install ./opencanon.bundle.ts --option sourceRoot=src
bun run opencanon bundle inspect https://example.com/opencanon.bundle.json --sha256 <hash>
```

Bundles may declare typed `options`; pass values with repeated `--option key=value`. Local bundles may be TypeScript modules or JSON data files. Remote bundles must be JSON data files, must use HTTPS, and must be pinned with `--sha256 <hash>`; OpenCanon does not execute remote TypeScript.

Local example bundles include `migration-control`, `dry-graph`, `security-hardcoding`, and `tauri-desktop`.

Project-level before/after examples live under `examples/projects/`. They show the expected repository shape after an agent applies a bundle or convention: source edits, docs, decisions, validators, and fixtures.

## Runtime

Daemon-backed commands are fail-fast about prerequisites. They require Bun `1.3.13` and the engine binary under `.agents/skills/opencanon/runtime/engine/`.

```bash
bun run opencanon daemon check
bun run opencanon daemon start
bun run opencanon daemon status
bun run opencanon daemon stop
bun run opencanon dev
```

`daemon start` runs the current project's daemon in the background and registers it in `~/.opencanon/daemons.json`; project-local generated state remains under `.opencanon/` and is ignored by Git. Normal `context`, `rules`, `validate`, `feedback`, and hook commands reuse that daemon when it is running, or start an isolated in-process ephemeral daemon for the single request. `dev` starts the daemon and serves the UI.

## Runtime Updates

Engine runtime installation is manifest-driven and local to each checkout. The CLI detects the current target from `process.platform` and `process.arch`, selects that target in the manifest, verifies the downloaded asset's SHA-256, and writes the canonical engine binary path atomically under the ignored `.agents/skills/opencanon/runtime/` directory. Manifest and asset URLs must be HTTPS, `file:`, or local paths. The agent may run the command, but the CLI owns target selection, URL resolution, checksum verification, and install path.

```bash
bun run opencanon update check --manifest ./opencanon-runtime-manifest.json
bun run opencanon update apply --manifest ./opencanon-runtime-manifest.json
OPENCANON_UPDATE_MANIFEST=https://example.com/opencanon-runtime-manifest.json bun run opencanon update check
```

`update apply` refuses to write while this project's daemon is running. Stop the daemon first, apply the update, then run `daemon check`, `doctor`, and `daemon start`.

Release producers build the generated runtime, generate manifests with `bun run release:manifest`, publish the manifest beside the runtime archive and engine assets, and run `bun run rehearse:install -- --manifest <manifest>` before marking a release usable.
The release also writes `<channel>.json` and `latest.json` with the same schema as `opencanon-runtime-manifest.json`, so agents can point `--manifest` or `OPENCANON_UPDATE_MANIFEST` at a stable channel or latest reference.

## Skill Install

Install OpenCanon through the skills.sh CLI:

```bash
npx skills add nick-vi/opencanon --skill opencanon -a codex -y
```

Minimal manifest shape:

```json
{
  "version": 1,
  "channel": "stable",
  "skillVersion": "0.3.10",
  "requiredBun": "1.3.13",
  "daemonSchema": 1,
  "runtime": {
    "url": "./opencanon-skill-runtime.tar.gz",
    "sha256": "<64 hex chars>",
    "format": "tar.gz"
  },
  "engine": {
    "darwin-arm64": {
      "url": "./opencanon.darwin-arm64.node",
      "sha256": "<64 hex chars>",
      "schemaVersion": 1
    }
  }
}
```

## Config

`opencanon.config.json` is optional. Without it, OpenCanon uses built-in defaults:

- docs: `docs/opencanon/decisions.json`; decisions link to Markdown headings with `docs` refs such as `docs/opencanon/canon/architecture.md#imports`
- validators: `.agents/skills/opencanon/validators/index.ts`
- fixtures: `.agents/skills/opencanon/fixtures`
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
  "decisionsPath": "docs/opencanon/decisions.json",
  "validatorsPath": ".agents/skills/opencanon/validators/index.ts",
  "fixturesDir": ".agents/skills/opencanon/fixtures",
  "impactSurfacesPath": "docs/opencanon/impact-surfaces.json",
  "proposedImpactNotesPath": "docs/opencanon/proposed-impact-notes.json",
  "baselinePath": ".opencanon/baseline.json",
  "cacheDir": ".opencanon/cache",
  "fileDiscovery": "git",
  "maxFiles": 20000,
  "maxFileSizeKb": 512,
  "projectFilePatterns": ["src/**/*.{ts,tsx,js,jsx,py,svelte,css,scss,sass,less,json,md}", "tests/**/*.{ts,tsx,js,jsx,py,svelte,css,scss,sass,less,json,md}"],
  "ignore": ["node_modules/**", ".git/**", ".agents/**", ".opencanon/**"],
  "entrypoints": ["src/main.ts"],
  "publicSurfaces": ["src/api/**"],
  "generated": ["src/generated/**"],
  "externalTools": {
    "knip": ["bunx", "knip"],
    "semgrep": {
      "command": "semgrep",
      "versionArgs": ["--version"],
      "missingSeverity": "warning",
      "timeoutMs": 5000
    }
  }
}
```

When the effective discovery mode is `git`, OpenCanon requires a Git repository and never silently falls back to filesystem traversal. Git discovery respects `.gitignore`, then OpenCanon applies `projectFilePatterns`, `ignore`, `maxFiles`, and `maxFileSizeKb`. `validate --changed` and `feedback --changed` use the same project scope before running validators. Use `fileDiscovery: "filesystem"` as an explicit override for tests, benchmarks, or non-Git experiments. Parser results are cached under `cacheDir`; `init` and `setup` add root ignore rules for cache, daemon state, setup state, and SQLite state, plus a skill-local `.gitignore` for installed runtime artifacts. `doctor` verifies them.

Invalid config is a hard failure for normal `context` and `validate` commands. `doctor` reports the same diagnostics and can repair generated artifact ignore entries with `--fix safe`.

`externalTools` declares trusted project-local tool aliases for validators and bundles. OpenCanon does not install those CLIs globally. Bundle installs can add the alias, docs, decisions, validators, and owned helper files. Bundles may expose typed `options` for project-specific paths, names, strictness, or other bounded values; the CLI validates those options and interpolates `{{optionName}}` placeholders before writing. Local bundles may be TypeScript modules. Remote bundles must be JSON data files, must use HTTPS, and must be pinned with `--sha256 <hash>`; OpenCanon does not execute remote TypeScript. Bundle-owned file targets are rejected for repo control and generated state paths such as `.git`, `.opencanon`, `node_modules`, package manifests, and lockfiles. Review `inspect`, `plan`, and `--dry-run` output before installing third-party bundles. `doctor` validates declarations by default; use `doctor --run-external-tools` to execute configured `versionArgs`. Missing tools default to `error`; use `missingSeverity: "warning"` or `"ignore"` when a tool is optional.

## Validator Contract

Core validator APIs are exposed to repositories through `.agents/skills/opencanon/index.ts`. The configured validator entrypoint exports one validator definition or an array of definitions. Validators are defined with `defineValidator({ ... })` and run with one destructurable argument:

```ts
import { defineValidator } from "../../../.agents/skills/opencanon/index.ts";

export default defineValidator({
  id: "service-conventions",
  topics: ["service"],
  severity: "error",
  scope: "file",
  facts: ["imports"],
  applies: ["src/services/**/*.ts"],
  analysis: ["src/**/*.ts"],
  summary: ({ applies, scope, facts }) =>
    `Files matching ${applies.join(", ")} must follow ${scope} conventions using ${facts.join(", ")} facts.`,
  validate({ ctx, runtime }) {
    return [];
  },
});
```

- `scope` is required on every real validator or inherited from a parent. Valid scopes are `file`, `folder`, `import-edge`, `package`, and `project`.
- `facts` declares the parsed facts a validator consumes. Valid fact kinds are `imports`, `exports`, `symbols`, `calls`, `literals`, `comments`, `references`, `annotations`, `diagnostics`, and `duplicates`.
- `analysis` is optional. It widens the parsed fact scope beyond current target files for cross-scope rules, for example validating TypeScript files while also reading `src-tauri/src/**/*.rs`. It is a fact-scope hint, not an access boundary.
- `summary` is optional rule metadata for `opencanon rules`. It can be a string or a synchronous definition-time callback that receives resolved `id`, `topics`, `applies`, `severity`, `scope`, `facts`, and `decisionIds`.
- `ctx.files` exposes discovered project files.
- `ctx.targetFiles` is the current validation scope matched by `applies` or CLI input.
- `ctx.facts.*` is the canonical validator data API. It exposes `imports()`, `exports()`, `symbols()`, `calls()`, `literals()`, `comments()`, `references()`, `annotations()`, `diagnostics()`, and `duplicates()` over the current analysis scope, which defaults to `ctx.targetFiles` in CLI validation.
- `ctx.graph.*` exposes graph-shaped `symbols()`, `references()`, `callers()`, `callees()`, and `impact()` over the same fact scope.
- Import analysis resolves relative, TS path-alias, and workspace-package imports against discovered project files, even when only target files are parsed.
- `ctx.impact.*` exposes configured impact surfaces, downstream domain edges, required checks, and proposed impact notes for touched files.
- `ctx.baseline.*` exposes known findings from the configured baseline file.
- `ctx.projectFiles(patterns?)` returns discovered project files independent of current target and analysis scope. `ctx.byGlob(patterns)` is kept as a concise alias.
- `ctx.text(path)`, `ctx.json(path)`, and `ctx.jsonFiles(patterns)` load structured project/config files on demand.
- `ctx.workspace()` exposes package/app ownership, dependencies, and import edges for monorepo validators.
- `ctx.folders()` exposes discovered project folders.
- `ctx.tree(...)` validates project structure, naming, folders, import boundaries, and relative import depth.
- Individual files expose lazy text helpers. Parser-specific helpers still exist for framework internals and exceptional validators. Prefer `ctx.facts.*` so language adapters can expand without changing rule code.

Validator results can be synchronous or asynchronous. The CLI awaits all validators and sorts findings deterministically. This is async-safe execution, not worker-thread CPU parallelism.

Large repos should split validators by domain and keep the configured entrypoint as a small barrel:

```ts
import api from "./api.ts";
import tauri from "./tauri.ts";

export default [api, tauri];
```

Domain modules can export a parent validator with nested `validators: []` so topics, decisions, facts, and applies scopes are inherited consistently.

Finding resolution policy: any validation finding must be addressed before an agent completes the task. Agents fix code to match current decisions, fix bugged validators with fixtures when the validator is wrong, or ask the user before changing a decision. `error` findings are blocking and make the CLI exit nonzero. `warning` findings are non-blocking by default; the CLI exits zero unless `--strict-warnings` is used. Markdown validation output includes a decision-update request template and points to `context --list-exceptions` for auditing documented exceptions.

Curated factories are optional imports from the skill barrel. They are never auto-enabled; the local validator file remains the source of truth. Available factories include `fileNames`, `folderStructure`, `noImports`, `noForbiddenImports`, `noDeepRelativeImports`, `noFolderNames`, `noNativeEnums`, `noUnusedExports`, `similarFunctionNames`, `migrationReferences`, `noSecretLikeLiterals`, `noHardcodedConfigValues`, `repeatedLiterals`, `duplicateBoundaryLiterals`, `annotationRequiresTags`, `noCommentMatches`, `noHeaderComments`, `noBypassComments`, `noForbiddenCalls`, `noBareExcept`, `noLayerCall`, `noBarrelCrossBoundary`, `restrictedSymbols`, `externalCommand`, `externalDiagnostics`, `requiredFunctionParam`, `requiredFileSibling`, `requireExportPattern`, `noShimFiles`, and `sensitiveChangePolicy`.

`noUnusedExports` uses `ctx.graph.callers()` and respects configured `entrypoints` and `publicSurfaces` so exported API files are not treated as dead code. A validator can add per-rule `entrypoints` or `publicSurfaces` when the project has additional public modules.

`migrationReferences` supports migration linkage: configure the old symbol or pattern, keep known matches in the baseline as warnings, fail new matches as errors, and optionally provide a structured replacement fix. This lets a repository deny new usage of an old API without requiring a single cleanup commit.

For DRY and boundary reviews, combine graph/search commands with validators. `opencanon search <name> --kind symbol --symbol-kind function --scope "src/domain/**"` finds similar functions in a boundary, while `opencanon graph callers <symbol>` and `opencanon graph callees <symbol>` show existing call flow before changing or extracting code. `similarFunctionNames` can turn those graph signals into a reusable validator for likely duplicate function surfaces.

Fixes can include structured edits or an advisory command. `--fix` applies only structured edits; command fixes are printed for the agent and are never executed by OpenCanon.

Refactor helpers are plan-first. The core API exports both individual helpers and `fixes.renameSymbol()`, `fixes.moveFile()`, `fixes.moveDir()`, `fixes.updateImports()`, `fixes.renamePackage()`, and `fixes.splitModule()`. Each returns a plan with diagnostics, edits, and file moves; writing happens only through explicit apply.

`externalCommand` and `externalDiagnostics` resolve `externalTools` aliases before spawning. Their `args` and `cwd` support `{root}`, `{config}`, `{cache}`, `{files}`, `{targetFiles}`, `{changed}`, `{analysisFiles}`, and `{projectFiles}`. Exact file-list tokens expand to multiple command arguments, and configured working directories must resolve inside the project root.

```ts
import { defineValidator, fileNames, noImports } from "../../../.agents/skills/opencanon/index.ts";

export default defineValidator({
  id: "conventions",
  validators: [
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
  ],
});
```

For Tauri apps, `tauriCommandParity` checks common frontend/Rust drift:

```ts
import { tauriCommandParity } from "../../../.agents/skills/opencanon/index.ts";

export default tauriCommandParity({
  id: "tauri-command-parity",
  topics: ["tauri"],
  severity: "error",
  frontend: ["src/**/*.{ts,tsx}"],
  rust: ["src-tauri/src/**/*.rs"],
  invokeFunctions: ["invoke", "tauriInvoke"],
  listenFunctions: ["listen", "tauriListen"],
  checkEvents: true,
  checkHandlerRegistration: true,
  message: "Tauri frontend calls must resolve to Rust commands and events.",
});
```

Repos can define their own factories beside local validators. Factories are inert until imported and called.

```ts
import { createValidatorFactory } from "../../../.agents/skills/opencanon/index.ts";

export const noRepositoryImport = createValidatorFactory<{ from: string[] }>(({ id, topics, severity, decisionIds, docs, from }) => ({
  id,
  topics,
  severity,
  scope: "import-edge",
  facts: ["imports"],
  decisionIds,
  applies: from,
  validate({ ctx }) {
    return ctx.facts.imports()
      .filter((edge) => edge.source.includes("/repositories/"))
      .map((edge) =>
        edge.from.report({
          line: edge.line,
          message: "Services must not import repositories directly.",
          docs,
        }),
      );
  },
}));
```

## Setup Command

Use `setup` for first-run installation and verification:

```bash
bun run opencanon setup --yes
bun run opencanon setup --yes --hooks codex
bun run opencanon setup --yes --hooks codex,claude,opencode
bun run opencanon setup --yes --manifest ./opencanon-runtime-manifest.json
bun run opencanon setup --yes --no-daemon
bun run opencanon setup --dry-run
```

`setup` is non-interactive and safe to rerun. It calls the deterministic scaffold path for missing files, installs the current-platform engine binary from a release manifest when one is supplied by the installed skill or `--manifest`, validates the OpenCanon context, runs doctor, runs project validation, checks the pinned Bun/engine daemon prerequisites, starts the supervised daemon by default, and records generated setup state in `.opencanon/setup.json`.

## Init

Use `init` only for lower-level scaffold work. Normal first-run setup should use `setup`.

```bash
bun run opencanon init
bun run opencanon init --non-interactive
bun run opencanon init --non-interactive --dry-run
```

`init` creates the scaffold without running the full setup checks, runtime update, doctor, validation, or daemon start. `--yes` is accepted as a short alias for `--non-interactive`.

## Validator Testing

Validator behavior is tested with fixtures, not ad hoc prose. Each real validator has:

- `.agents/skills/opencanon/fixtures/<validator-id>/valid`
- `.agents/skills/opencanon/fixtures/<validator-id>/invalid`
- optional `.agents/skills/opencanon/fixtures/<validator-id>/fixed` when structured fixes are provided

Run one validator while iterating, then the full suite before finishing:

```bash
bun run opencanon validate --check-fixtures --validator <validator-id>
bun run opencanon validate --check-fixtures
```

Framework tests belong in this repo when changing core runtime behavior. Repository convention tests belong in fixture folders next to the local skill.

## Rule Browser

Use `rules` to inspect convention coverage without reading validator source:

```bash
bun run opencanon rules
bun run opencanon rules --validator service-no-db-client
bun run opencanon rules --topic boundaries
bun run opencanon rules --decision service-db-boundary
bun run opencanon rules --tree
bun run opencanon rules --tree --ascii --no-color
bun run opencanon rules --format json
```

The command renders each validator's severity, summary, topics, applies scopes, decision ids, fixture coverage, and matching validation command. Summaries are static after validator resolution, even when produced by a definition-time callback.

Tree-backed validators can expose terminal visualizations through `rules --tree`. Unicode tree lines are used by default; use `--ascii` for plain terminals and `--no-color` or `NO_COLOR=1` to disable ANSI colors. JSON output includes the raw visual metadata for agents and tools.

## Agent Feedback Hooks

OpenCanon exposes the same validation result through manual feedback and host hook adapters:

```bash
bun run opencanon feedback --files src/services/company.service.ts
bun run opencanon feedback --changed
bun run opencanon feedback --changed --strict-warnings
bun run opencanon hook codex < hook-payload.json
bun run opencanon hook claude < hook-payload.json
bun run opencanon hook opencode < hook-payload.json
```

`feedback` is for on-demand agent use. `hook` is for host integrations that pass JSON on stdin and expect a host-specific response on stdout.

Use `hook config` to print installation snippets:

```bash
bun run opencanon hook config codex
bun run opencanon hook config claude
bun run opencanon hook config opencode
```

Use `hook install` to write project-local or user-global hook config:

```bash
bun run opencanon hook install codex
bun run opencanon hook install claude
bun run opencanon hook install opencode
bun run opencanon hook install --all --dry-run
```

- Codex uses `PostToolUse` with matcher `Edit|Write|apply_patch`; hooks require `[features] codex_hooks = true`.
- Claude Code uses `PostToolUse` with matcher `Write|Edit|MultiEdit`.
- OpenCode discovers the OpenCanon skill from `.agents/skills/opencanon`. Its local plugin loader uses `.opencode/plugins/opencanon.ts` to import the plugin from the `.agents` skill.

Hook adapters validate only files extracted from the write/edit payload. Codex `apply_patch` payloads are parsed from patch markers, OpenCode `apply_patch` uses `patchText`, and deleted files are ignored because there is no post-delete source file to validate. Hook feedback dedupes repeated findings within a host turn when the host exposes a turn or call id. Markdown feedback is grouped by file, capped by a character budget, and includes the exact `opencanon validate --files ...` command for the full report.
