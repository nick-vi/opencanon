# Services compose DAL instead of direct DB clients

## Rule

Services own workflow composition but should use DAL modules for persistence details.

## Applies to

- `src/services/**/*.{ts,tsx}`
- `packages/*/src/services/**/*.{ts,tsx}`

## Why

DAL modules keep table/query details in one layer. Services stay focused on business sequencing and transactions.

## Related conventions

- [Services do not import DB clients](service-no-db-client.md)
