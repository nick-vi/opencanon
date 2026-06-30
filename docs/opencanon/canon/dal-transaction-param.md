# DAL functions keep transaction clients last

Convention id: `dal-transaction-param`.
Render style: `reference`.

## Rule

Rule: Exported DAL functions should accept an optional transaction/client parameter and route queries through a transaction-aware client.

## Applies to

Kind: `files`
- file glob `src/db/dal/**/*.{ts,tsx}`

## Runtime checks

Kind: `validator`
Severity: `error`
Scope: `file`
Facts: `symbols`

## Why

Rationale: No rationale is recorded.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [dal-transaction-flow](opencanon://conventions/dal-transaction-flow)
