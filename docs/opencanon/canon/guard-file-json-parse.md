# JSON.parse of file I/O must be guarded by try/catch

Convention id: `guard-file-json-parse`.
Render style: `reference`.

## Rule

Rule: Parsing file contents with JSON.parse must sit inside a try/catch so a malformed file degrades gracefully instead of throwing an unhandled SyntaxError.

## Applies to

Kind: `files`
- file glob `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: JSON.parse throws a SyntaxError on malformed input; an unguarded parse of an on-disk file turns a corrupt or partially-written file into a process crash. File contents are untrusted input at runtime (user edits, partial writes, version skew) and should be treated defensively. Graceful degradation (default value, skipped entry, reported diagnostic) keeps tooling usable when a single file is bad.

## Examples

Example 1:
Note: let data; try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { data = null; }

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [no-unguarded-json-parse](opencanon://conventions/no-unguarded-json-parse)
