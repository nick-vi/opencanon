# Agent Feedback and Gates

Area id: `agent-feedback-and-gates`.
Render style: `reference`.

## Summary

Summary: Agent hooks and CLI feedback surface related conventions, impact surfaces, findings, and explicit approval gates.

## Ownership

Files: packages/core/src/feedback.ts, packages/core/src/commit-approvals.ts, packages/core/src/hook-install.ts, packages/cli/src/feedback.ts, packages/cli/src/gate.ts
Commands: opencanon feedback (cli), opencanon gate (cli)

## Impact surfaces

No impact surfaces are linked.

## Checks

- `feedback-tests` test `tests/feedback.test.ts`
- `project-doctor` doctor

## Stories

Story `feedback-after-edits`: as agent, I want concise feedback after editing files, so I can correct drift before commit.
- feedback includes related changes and impact surfaces
- unresolved gates are persisted for approval
Checks: `feedback-tests`, `project-doctor`

## Behaviors

Behavior `commit-gate-records-user-intent`: commit gate requires approval for sensitive changes; approval context is recorded outside committed canon definitions.
Checks: `feedback-tests`

## Dependencies

No area dependencies are recorded.

## Governance

- infer governing conventions from owned scope
- convention [sensitive-change-requires-approval](opencanon://conventions/sensitive-change-requires-approval)
