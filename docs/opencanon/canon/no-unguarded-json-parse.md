# File JSON.parse calls are guarded

## Rule

JSON.parse() of file I/O must sit inside a try/catch so a malformed file degrades instead of crashing.

## Applies to

- `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

- Kind: `validator`
- Severity: `warning`
- Scope: `file`
- Facts: `calls`
- Fixtures: `valid-and-invalid`

## Related conventions

- [JSON.parse of file I/O must be guarded by try/catch](guard-file-json-parse.md)
