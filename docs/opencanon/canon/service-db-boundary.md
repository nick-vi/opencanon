# Services compose DAL instead of direct DB clients

Convention id: `service-db-boundary`.
Render style: `reference`.

## Rule

Rule: Services own workflow composition but should use DAL modules for persistence details.

## Applies to

Kind: `files`
- file glob `src/services/**/*.{ts,tsx}`
- file glob `packages/*/src/services/**/*.{ts,tsx}`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: DAL modules keep table/query details in one layer. Services stay focused on business sequencing and transactions.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [service-no-db-client](opencanon://conventions/service-no-db-client)
