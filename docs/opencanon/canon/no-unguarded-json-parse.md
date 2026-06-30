# File JSON.parse calls are guarded

Convention id: `no-unguarded-json-parse`.
Render style: `reference`.

## Rule

Rule: JSON.parse() of file I/O must sit inside a try/catch so a malformed file degrades instead of crashing.

## Applies to

Kind: `files`
- file glob `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

Kind: `validator`
Severity: `warning`
Scope: `file`
Facts: `calls`
Fixtures: `valid-and-invalid`

## Why

Rationale: No rationale is recorded.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [guard-file-json-parse](opencanon://conventions/guard-file-json-parse)
