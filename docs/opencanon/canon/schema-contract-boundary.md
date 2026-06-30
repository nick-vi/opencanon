# Schemas define contracts at package boundaries

Convention id: `schema-contract-boundary`.
Render style: `reference`.

## Rule

Rule: Validation schemas and DTO contracts live at boundaries; internals use typed domain objects.

## Applies to

Kind: `files`
- file glob `src/contracts/**/*.{ts,tsx}`
- file glob `src/db/schema/**/*.{ts,tsx}`
- file glob `src/api/routes/**/*.{ts,tsx}`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: Boundary schemas stabilize request/response contracts. Database table definitions are persistence details and should not leak into public DTO modules.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [no-db-schema-in-contracts](opencanon://conventions/no-db-schema-in-contracts)
- [duplicate-boundary-literals](opencanon://conventions/duplicate-boundary-literals)
