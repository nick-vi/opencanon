# Imports avoid deep relative parent climbs

Convention id: `no-deep-relative-imports`.

## Rule

Deep relative import crosses too many ownership levels.

## Applies to

- from `src/**/*.{ts,tsx}`
- from `tests/**/*.{ts,tsx}`
- from `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

- Kind: `validator`
- Severity: `warning`
- Scope: `import-edge`
- Facts: `imports`

## Related conventions

- [import-boundaries-current](opencanon://conventions/import-boundaries-current)
