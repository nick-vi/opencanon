# DAL functions accept optional transactions

## Rule

Database access functions accept an optional transaction/client so services can compose multi-step writes atomically.

## Applies to

- `src/db/dal/**/*.{ts,tsx}`
- `src/services/**/*.{ts,tsx}`
- `src/api/routes/**/*.{ts,tsx}`
- `packages/*/src/db/dal/**/*.{ts,tsx}`
- `packages/*/src/services/**/*.{ts,tsx}`
- `packages/*/src/api/routes/**/*.{ts,tsx}`

## Why

Services often need multi-step writes to commit or roll back as one unit. Routes should stay HTTP-focused and not know persistence details. One transaction-aware DAL pattern is cleaner than parallel transactional/non-transactional helpers.

## Examples

- src/db/dal/company.ts shows the transaction-aware DAL shape.

- src/api/routes/companies.ts shows a route calling a service instead of DAL.

## Related conventions

- [dal-transaction-param](opencanon://conventions/dal-transaction-param)
- [no-route-dal-import](opencanon://conventions/no-route-dal-import)
- [service-no-db-client](opencanon://conventions/service-no-db-client)
