# Schemas define contracts at package boundaries

## Rule

Validation schemas and DTO contracts live at boundaries; internals use typed domain objects.

## Applies to

- `src/contracts/**/*.{ts,tsx}`
- `src/db/schema/**/*.{ts,tsx}`
- `src/api/routes/**/*.{ts,tsx}`

## Why

Boundary schemas stabilize request/response contracts. Database table definitions are persistence details and should not leak into public DTO modules.

## Related conventions

- [no-db-schema-in-contracts](opencanon://conventions/no-db-schema-in-contracts)
- [duplicate-boundary-literals](opencanon://conventions/duplicate-boundary-literals)
