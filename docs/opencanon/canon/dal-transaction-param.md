# DAL functions keep transaction clients last

## Rule

Exported DAL functions should accept an optional transaction/client parameter and route queries through a transaction-aware client.

## Applies to

- `src/db/dal/**/*.{ts,tsx}`

## Runtime checks

- Kind: `validator`
- Severity: `error`
- Scope: `file`
- Facts: `symbols`

## Related conventions

- [dal-transaction-flow](opencanon://conventions/dal-transaction-flow)
