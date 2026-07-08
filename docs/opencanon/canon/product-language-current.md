# Product-facing language stays simple

## Rule

Use Project Canon, Proof, Knowledge, Activity, Areas, Specs, Changes, Surfaces, Project Map, Search, Doctor, and Health in product-facing surfaces unless an exact internal type is required.

## Applies to

- `README.md`
- `docs/opencanon/**/*.md`
- `apps/site/src/**/*.{svelte,js,ts}`
- `.agents/skills/**/*.md`
- `AGENTS.md`
- `CLAUDE.md`

## Runtime checks

- Kind: `validator`
- Severity: `warning`
- Scope: `file`

## Why

The internal model needs precise terms, but docs and agent guidance should present a smaller vocabulary so humans and agents do not treat implementation details as product concepts.

## Examples

- Use Project Canon as the umbrella for conventions, areas, specs, and changes; keep definitionGraph in code.

- Use Changes in navigation; keep ChangeSummary as the internal DTO name.

- Use Knowledge or Search in app copy; keep Semantic Index and chunks in runtime architecture.

- Use Proof for checks, validators, gates, doctor, and coverage; keep exact runtime kind names where they matter.

- Use Activity for events, agent runs, indexing progress, check results, and logs.

## Related impact surfaces

- [Project Canon model](../areas/project-map-governance.md#project-map-governance)
