# Product-facing language stays simple

Convention id: `product-language-current`.
Render style: `reference`.

## Rule

Rule: Use Project Canon, Proof, Knowledge, Activity, Areas, Specs, Changes, Surfaces, Project Map, Search, Doctor, and Health in product-facing surfaces unless an exact internal type is required.

## Applies to

Kind: `files`
- file glob `README.md`
- file glob `docs/opencanon/**/*.md`
- file glob `apps/site/src/**/*.{svelte,js,ts}`
- file glob `.agents/skills/**/*.md`
- file glob `AGENTS.md`
- file glob `CLAUDE.md`

## Runtime checks

Kind: `validator`
Severity: `warning`
Scope: `file`
Facts: none

## Why

Rationale: The internal model needs precise terms, but docs and agent guidance should present a smaller vocabulary so humans and agents do not treat implementation details as product concepts.

## Examples

Example 1:
Note: Use Project Canon as the umbrella for conventions, areas, specs, and changes; keep definitionGraph in code.

Example 2:
Note: Use Changes in navigation; keep ChangeSummary as the internal DTO name.

Example 3:
Note: Use Knowledge or Search in app copy; keep Semantic Index and chunks in runtime architecture.

Example 4:
Note: Use Proof for checks, validators, gates, doctor, and coverage; keep exact runtime kind names where they matter.

Example 5:
Note: Use Activity for events, agent runs, indexing progress, check results, and logs.

## Related impact surfaces

- [project-canon-model](opencanon://impact-surfaces/project-canon-model)

## Related conventions

No related conventions are recorded.
