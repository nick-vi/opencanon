---
name: opencanon
description: Use when building, reviewing, debugging, or explaining a project governed by OpenCanon Project Canon, Proof, Knowledge, Activity, or Health.
---

# OpenCanon

OpenCanon is installed as a runtime. This skill is a compact agent entrypoint: use the `opencanon` CLI or MCP for live project state, scoped context, validation, task progress, Search, and Health.

## Operating Rules

1. Start with `opencanon brief --format json` when no narrower command is obvious.
2. Treat project source and TypeScript definitions under `opencanon/` as source truth.
3. Do not hand-edit OpenCanon-owned generated docs, generated authoring files, runtime events, SQLite state, cache files, or this managed skill.
4. For active Changes, update progress with `opencanon changes ...`; the Change definition owns the plan, not mutable task status.
5. Run focused Proof before finishing and `opencanon doctor` when generated artifacts, init state, Health, or Knowledge may be stale.

## Workflow

1. Brief or scope: `opencanon brief --format json`, `opencanon context --files <paths...>`, or `opencanon context --changed`.
2. Classify durable intent: Area for ownership, Spec for behavior, Convention for rules, Change for active implementation, Proof for checks, Knowledge for retrieval, Activity for events, Health for setup/runtime correctness.
3. Track active work: `opencanon changes ready --format json`, `opencanon changes show <change-id> --format json`, then create a managed worktree or claim/start/check/review/close tasks explicitly.
4. Search before guessing: use `opencanon search <query>`, `opencanon ask "<question>"`, `opencanon canon map --format json`, symbols, and graph commands.
5. Implement and prove: edit source, render generated docs when definitions change, run scoped validation, then broaden checks based on risk.

## Progressive References

Read only the file that matches the current task.

- [Greenfield App Workflow](references/greenfield-app.md): creating or reshaping an app under OpenCanon.
- [Project Canon Authoring](references/canon-authoring.md): changing Areas, Specs, Changes, conventions, generated docs, or entry files.
- [Implementation Workflow](references/implementation.md): implementing a feature, fix, refactor, or generated artifact change.
- [Change And Task Planning](references/change-planning.md): decomposing work into tracked Changes and task graphs.
- [Review Workflow](references/review.md): reviewing local edits, PRs, generated artifacts, or Proof coverage.
- [Search And Knowledge](references/search-knowledge.md): navigating code, docs, chunks, symbols, backlinks, and relationships.
- [Health And Runtime](references/health-runtime.md): diagnosing setup, service, project runtime, indexing, logs, or stale state.
- [Release Readiness](references/release.md): checking packaging, update assets, install rehearsal, or release readiness without publishing.

## Common Commands

```bash
opencanon status --format json
opencanon setup --yes --format json
opencanon brief --format json
opencanon context --files <paths...>
opencanon context --changed
opencanon changes ready --format json
opencanon changes show <change-id> --format json
opencanon worktree create <change-id> --task <task-id>
opencanon worktree list --format json
opencanon validate --files <paths...>
opencanon validate --changed
opencanon doctor
```
