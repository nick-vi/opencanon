# DAL functions accept optional transactions

Convention id: `dal-transaction-flow`.
Render style: `reference`.

## Rule

Rule: Database access functions accept an optional transaction/client so services can compose multi-step writes atomically.

## Applies to

Kind: `files`
- file glob `src/db/dal/**/*.{ts,tsx}`
- file glob `src/services/**/*.{ts,tsx}`
- file glob `src/api/routes/**/*.{ts,tsx}`
- file glob `packages/*/src/db/dal/**/*.{ts,tsx}`
- file glob `packages/*/src/services/**/*.{ts,tsx}`
- file glob `packages/*/src/api/routes/**/*.{ts,tsx}`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: Services often need multi-step writes to commit or roll back as one unit. Routes should stay HTTP-focused and not know persistence details. One transaction-aware DAL pattern is cleaner than parallel transactional/non-transactional helpers.

## Examples

Example 1:
Note: src/db/dal/company.ts shows the transaction-aware DAL shape.

Example 2:
Note: src/api/routes/companies.ts shows a route calling a service instead of DAL.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [dal-transaction-param](opencanon://conventions/dal-transaction-param)
- [no-route-dal-import](opencanon://conventions/no-route-dal-import)
- [service-no-db-client](opencanon://conventions/service-no-db-client)
