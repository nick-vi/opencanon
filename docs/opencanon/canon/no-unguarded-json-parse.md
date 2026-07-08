# File JSON.parse calls are guarded

Convention id: `no-unguarded-json-parse`.

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

- [guard-file-json-parse](opencanon://conventions/guard-file-json-parse)
