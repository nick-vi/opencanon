import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { relative } from "./core-utils.ts";

export const OpenCanonSkillRoot = ".agents/skills/opencanon";
export const OpenCanonSkillFilePath = `${OpenCanonSkillRoot}/SKILL.md`;

export type OpenCanonSkillArtifact = {
  path: string;
  content: string;
  mode?: number;
};

const executableMode = 0o755;

function md(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

export const OpenCanonSkillArtifacts: OpenCanonSkillArtifact[] = [
  {
    path: OpenCanonSkillFilePath,
    content: md([
      "---",
      "name: opencanon",
      "description: Use when building, reviewing, debugging, or explaining a project governed by OpenCanon Project Canon, Proof, Knowledge, Activity, or Health.",
      "---",
      "",
      "# OpenCanon",
      "",
      "OpenCanon is installed as a runtime. This skill is a compact agent entrypoint: use the `opencanon` CLI or MCP for live project state, scoped context, validation, task progress, Search, and Health.",
      "",
      "## Operating Rules",
      "",
      "1. Start with `opencanon brief --format json` when no narrower command is obvious.",
      "2. Treat project source and TypeScript definitions under `opencanon/` as source truth.",
      "3. Do not hand-edit OpenCanon-owned generated docs, generated authoring files, runtime events, SQLite state, cache files, or this managed skill.",
      "4. For active Changes, update progress with `opencanon changes ...`; the Change definition owns the plan, not mutable task status.",
      "5. Run focused Proof before finishing and `opencanon doctor` when generated artifacts, init state, Health, or Knowledge may be stale.",
      "",
      "## Workflow",
      "",
      "1. Brief or scope: `opencanon brief --format json`, `opencanon context --files <paths...>`, or `opencanon context --changed`.",
      "2. Classify durable intent: Area for ownership, Spec for behavior, Convention for rules, Change for active implementation, Proof for checks, Knowledge for retrieval, Activity for events, Health for setup/runtime correctness.",
      "3. Track active work: `opencanon changes ready --format json`, `opencanon changes show <change-id> --format json`, then create a managed worktree or claim/start/check/review/close tasks explicitly.",
      "4. Search before guessing: use `opencanon search <query>`, `opencanon ask \"<question>\"`, `opencanon canon map --format json`, symbols, and graph commands.",
      "5. Implement and prove: edit source, render generated docs when definitions change, run scoped validation, then broaden checks based on risk.",
      "",
      "## Progressive References",
      "",
      "Read only the file that matches the current task.",
      "",
      "- [Greenfield App Workflow](references/greenfield-app.md): creating or reshaping an app under OpenCanon.",
      "- [Project Canon Authoring](references/canon-authoring.md): changing Areas, Specs, Changes, conventions, generated docs, or entry files.",
      "- [Implementation Workflow](references/implementation.md): implementing a feature, fix, refactor, or generated artifact change.",
      "- [Change And Task Planning](references/change-planning.md): decomposing work into tracked Changes and task graphs.",
      "- [Review Workflow](references/review.md): reviewing local edits, PRs, generated artifacts, or Proof coverage.",
      "- [Search And Knowledge](references/search-knowledge.md): navigating code, docs, chunks, symbols, backlinks, and relationships.",
      "- [Health And Runtime](references/health-runtime.md): diagnosing setup, service, project runtime, indexing, logs, or stale state.",
      "- [Release Readiness](references/release.md): checking packaging, update assets, install rehearsal, or release readiness without publishing.",
      "",
      "## Common Commands",
      "",
      "```bash",
      "opencanon status --format json",
      "opencanon setup --yes --format json",
      "opencanon brief --format json",
      "opencanon context --files <paths...>",
      "opencanon context --changed",
      "opencanon changes ready --format json",
      "opencanon changes show <change-id> --format json",
      "opencanon worktree create <change-id> --task <task-id>",
      "opencanon worktree list --format json",
      "opencanon validate --files <paths...>",
      "opencanon validate --changed",
      "opencanon doctor",
      "```",
    ]),
  },
  {
    path: `${OpenCanonSkillRoot}/references/greenfield-app.md`,
    content: md([
      "# Greenfield App Workflow",
      "",
      "Use OpenCanon when a project needs durable intent, runtime Proof, and agent-friendly context from the beginning.",
      "",
      "1. Run `opencanon setup --yes --format json` to scaffold the repo and get an agent setup packet.",
      "2. Use the setup packet to propose the smallest useful Project Canon first: one Area for ownership, one Spec for durable behavior, and one Change for the implementation plan.",
      "3. Add conventions only when they express a rule that should outlive the current task or be enforced by Proof.",
      "4. Keep generated docs derived from definitions. If rendered docs are wrong, fix the definition or renderer.",
      "5. Start implementation from `opencanon brief --format json` or a specific `changes show` packet so work is grounded in ready tasks and current context.",
      "6. Run scoped Proof before broad Proof: `validate --files`, declared `changes check`, then `doctor` when generated artifacts or setup changed.",
    ]),
  },
  {
    path: `${OpenCanonSkillRoot}/references/canon-authoring.md`,
    content: md([
      "# Project Canon Authoring",
      "",
      "Project Canon is authored as TypeScript definitions. OpenCanon-owned docs are deterministic renders of those definitions.",
      "",
      "- Area: ownership, Surfaces, stories, behaviors, and checks.",
      "- Spec: durable product or system behavior, governing rules, scenarios, scope, and checks.",
      "- Convention: a durable rule, with optional runtime validator, gate, or test-backed Proof.",
      "- Change: active implementation work with tasks, dependencies, files, checks, blockers, and runtime Activity.",
      "",
      "Authoring flow:",
      "",
      "1. Use `canon list` and `canon map` to avoid duplicating an existing definition.",
      "2. Add or edit the TypeScript definition under `opencanon/`.",
      "3. Link scope, Surfaces, governing conventions, checks, and generated docs explicitly.",
      "4. Render the affected docs with `canon render <kind>`.",
      "5. Run `doctor`; generated artifact drift is a source-truth bug.",
      "",
      "Do not add persisted proposed/active status fields to definitions. A committed definition is ratified. Mutable execution state belongs in runtime Activity or generated local state.",
    ]),
  },
  {
    path: `${OpenCanonSkillRoot}/references/implementation.md`,
    content: md([
      "# Implementation Workflow",
      "",
      "Implementation starts by loading the smallest context that can make the work correct.",
      "",
      "1. Run `brief --format json` for ready work, or `context --files <paths...>` when the touched files are known.",
      "2. If the work maps to a Change and can run in isolation, run `worktree create <change-id> --task <task-id>` from the project root, move into the printed worktree, then start the task.",
      "3. If the work must stay in the current checkout, run `changes show <change-id> --format json`, then `changes claim <change-id> --task <task-id>` and `changes start <change-id> --task <task-id>` before editing.",
      "4. Edit source definitions first when behavior, rules, docs, or agent instructions change; render generated docs after source changes.",
      "5. Keep generated state derived. If a generated doc is wrong, fix the definition or renderer.",
      "6. Run the narrowest relevant Proof, then broaden based on risk.",
      "7. Record blockers with `changes block` instead of leaving task state ambiguous.",
      "8. Move work to review or close only after declared checks pass.",
    ]),
  },
  {
    path: `${OpenCanonSkillRoot}/references/change-planning.md`,
    content: md([
      "# Change And Task Planning",
      "",
      "A Change is active implementation intent. Its task graph is committed definition data; task progress is runtime Activity.",
      "",
      "Use a Change when work has multiple steps, dependencies, meaningful checks, expected files, blockers, or runtime visibility needs.",
      "",
      "Good Change tasks include a stable id, clear title, expected files or Surfaces, dependencies, checks, and durable definition updates when completed work changes Project Canon.",
      "",
      "Agent flow:",
      "",
      "1. `changes ready --format json` to find unblocked work that has no active task lease.",
      "2. `changes show <change-id> --format json` to inspect dependencies, files, checks, and recent Activity.",
      "3. Prefer `worktree create <change-id> --task <task-id>` for parallel agent work; it creates the Git worktree and claims the task atomically.",
      "4. Use `changes claim` and `changes start` only when intentionally working in the current checkout.",
      "5. `changes check --all` to run declared checks.",
      "6. `changes review` or `changes close` only after Proof is available.",
      "7. `worktree list --format json` shows managed worktrees and active task leases; `worktree remove <id|path>` releases leases for a finished worktree.",
      "",
      "Do not mutate the Change definition to represent progress. Progress events live in runtime state so source intent stays reviewable.",
    ]),
  },
  {
    path: `${OpenCanonSkillRoot}/references/review.md`,
    content: md([
      "# Review Workflow",
      "",
      "Review starts from risk, not from a summary.",
      "",
      "1. Load changed-file context with `context --changed`.",
      "2. Check generated artifacts with `doctor` if docs, Project Canon, entry files, or runtime state changed.",
      "3. Run `validate --changed` for convention Proof.",
      "4. Use `review` for a read-only report when a concise CI-style view is useful.",
      "5. For each issue, cite the exact file, behavior, and missing Proof.",
      "",
      "Prioritize correctness, source-truth drift, broken generated artifacts, stale task state, runtime-process leaks, data loss, security issues, and missing tests for risky behavior.",
    ]),
  },
  {
    path: `${OpenCanonSkillRoot}/references/search-knowledge.md`,
    content: md([
      "# Search And Knowledge",
      "",
      "Knowledge retrieval is advisory context. Enforced behavior still comes from conventions, validators, gates, checks, tests, and Doctor.",
      "",
      "- Use `search <query>` for deterministic project-wide lookup across Project Canon, symbols, docs, validators, and indexed Knowledge.",
      "- Use `ask \"<question>\"` for evidence-backed answers over the current index.",
      "- Use `context --files <paths...>` when edits are scoped to files.",
      "- Use `canon map --format json` when relationships matter more than prose.",
      "- Use `symbols`, `graph callers`, and `graph callees` for code-navigation questions.",
      "",
      "Search results should guide where to inspect next. Do not treat semantic matches as Proof unless a declared check or validator confirms the behavior.",
    ]),
  },
  {
    path: `${OpenCanonSkillRoot}/references/health-runtime.md`,
    content: md([
      "# Health And Runtime",
      "",
      "OpenCanon should be either working or explicitly unhealthy. Hidden degraded modes are not a product goal.",
      "",
      "Useful checks:",
      "",
      "- `status --format json` for global and current-project status.",
      "- `service status --format json` for the global service.",
      "- `project status --format json` for the selected project runtime.",
      "- `project logs --tail 200` for runtime errors and indexing progress.",
      "- `project index` when derived project state needs to be rebuilt.",
      "- `doctor` for setup, generated artifacts, hooks, runtime prerequisites, and Health.",
      "",
      "If live project data looks stale, verify the project runtime event stream and logs first. Polling should not hide a broken live path.",
    ]),
  },
  {
    path: `${OpenCanonSkillRoot}/references/release.md`,
    content: md([
      "# Release Readiness",
      "",
      "Do not publish or push release assets unless the user explicitly asks.",
      "",
      "Useful checks:",
      "",
      "- `npm run build:engine` for native engine bindings.",
      "- `npm run build:runtime -- --bundle-node` for the packaged runtime tree.",
      "- `npm run release:check` for release metadata consistency.",
      "- `npm run release:manifest -- --asset-dir packages/engine/binaries --out-dir tmp/opencanon-release-check --channel stable --require-runtime --clean` for local manifest generation.",
      "- `npm run rehearse:install -- --manifest tmp/opencanon-release-check/opencanon-runtime-manifest.json --no-runtime` for install rehearsal.",
      "",
      "Release readiness is broader than `doctor`: it includes packaged assets, signing metadata, update manifest integrity, and install rehearsal.",
    ]),
  },
  {
    path: `${OpenCanonSkillRoot}/scripts/opencanon-project-status.sh`,
    content: "#!/usr/bin/env bash\nset -euo pipefail\nopencanon status --format json\n",
    mode: executableMode,
  },
  {
    path: `${OpenCanonSkillRoot}/scripts/opencanon-brief-context.sh`,
    content: "#!/usr/bin/env bash\nset -euo pipefail\nopencanon brief --format json\n",
    mode: executableMode,
  },
  {
    path: `${OpenCanonSkillRoot}/scripts/opencanon-search.sh`,
    content:
      "#!/usr/bin/env bash\nset -euo pipefail\nif [ \"$#\" -eq 0 ]; then\n  echo \"usage: $0 <query>\" >&2\n  exit 2\nfi\nopencanon search \"$*\"\n",
    mode: executableMode,
  },
  {
    path: `${OpenCanonSkillRoot}/scripts/opencanon-change-board.sh`,
    content: "#!/usr/bin/env bash\nset -euo pipefail\nopencanon changes list --format json\n",
    mode: executableMode,
  },
];

export function writeOpenCanonSkillArtifacts(rootDir: string): void {
  for (const artifact of OpenCanonSkillArtifacts) {
    const absolutePath = path.join(rootDir, artifact.path);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, artifact.content, artifact.mode === undefined ? undefined : { mode: artifact.mode });
    if (artifact.mode !== undefined) chmodSync(absolutePath, artifact.mode);
  }
}

export function validateOpenCanonSkillArtifacts(rootDir: string): string[] {
  const diagnostics: string[] = [];
  for (const artifact of OpenCanonSkillArtifacts) {
    const absolutePath = path.join(rootDir, artifact.path);
    const displayPath = relative(rootDir, absolutePath);
    if (!existsSync(absolutePath)) {
      diagnostics.push(`OpenCanon skill file is missing: ${displayPath}. Run opencanon doctor --fix.`);
      continue;
    }
    const actual = readFileSync(absolutePath, "utf8");
    if (actual !== artifact.content) diagnostics.push(`OpenCanon skill file drifted: ${displayPath}. Run opencanon doctor --fix.`);
    if (artifact.mode !== undefined && (statSync(absolutePath).mode & 0o111) === 0) {
      diagnostics.push(`OpenCanon skill script is not executable: ${displayPath}. Run opencanon doctor --fix.`);
    }
  }
  return diagnostics;
}
