# Product Docs and Agent Guidance

Area id: `product-docs-and-guidance`.
Render style: `reference`.

## Summary

Summary: The public docs, README, managed skill, and product copy explain OpenCanon as agent-ready, human-readable, runtime-enforced Project Canon, Proof, Knowledge, Activity, and Health.

## Ownership

Files: README.md, CHANGELOG.md, SECURITY.md, NOTICE.md, docs/*.md
Docs: .agents/skills/opencanon/SKILL.md, AGENTS.md, CLAUDE.md, docs/opencanon/areas/product-docs-and-guidance.md

## Impact surfaces

No impact surfaces are linked.

## Checks

- `project-doctor` doctor

## Stories

Story `plain-product-framing`: as developer, I want docs and agent guidance to use the same product vocabulary as the CLI, so I can understand what OpenCanon does before learning internal architecture.
- README and managed agent entries use Project Canon, Proof, Knowledge, Activity, and Health consistently
- generated docs remain derived from definitions
Checks: `project-doctor`

## Behaviors

Behavior `guidance-matches-cli-language`: agent guidance describes OpenCanon concepts; product-facing language matches CLI commands and generated Project Canon docs.
Checks: `project-doctor`

## Dependencies

No area dependencies are recorded.

## Governance

- infer governing conventions from owned scope
- convention [product-language-current](opencanon://conventions/product-language-current)
- convention [state-ownership-current](opencanon://conventions/state-ownership-current)
