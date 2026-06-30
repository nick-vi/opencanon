# Project Canon Authoring

Project Canon is authored as TypeScript definitions. OpenCanon-owned docs are deterministic renders of those definitions.

- Area: ownership, Surfaces, stories, behaviors, and checks.
- Spec: durable product or system behavior, governing rules, scenarios, scope, and checks.
- Convention: a durable rule, with optional runtime validator, gate, or test-backed Proof.
- Change: active implementation work with tasks, dependencies, files, checks, blockers, and runtime Activity.

Authoring flow:

1. Use `canon list` and `canon map` to avoid duplicating an existing definition.
2. Add or edit the TypeScript definition under `opencanon/`.
3. Link scope, Surfaces, governing conventions, checks, and generated docs explicitly.
4. Render the affected docs with `canon render <kind>`.
5. Run `doctor`; generated artifact drift is a source-truth bug.

Do not add persisted proposed/active status fields to definitions. A committed definition is ratified. Mutable execution state belongs in runtime Activity or generated local state.
