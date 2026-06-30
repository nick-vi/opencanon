# Python modules do not mutate sys.path

Convention id: `python-no-sys-path-mutation`.
Render style: `reference`.

## Rule

Rule: Python modules should not mutate sys.path to cross package boundaries.

## Applies to

Kind: `files`
- file glob `src/python/**/*.py`

## Runtime checks

Kind: `validator`
Severity: `warning`
Scope: `file`
Facts: none

## Why

Rationale: No rationale is recorded.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [python-module-boundaries](opencanon://conventions/python-module-boundaries)
