# Python catches specific exception types

Convention id: `python-no-bare-except`.

## Rule

Python code should catch specific exception types instead of using bare except clauses.

## Applies to

- `src/python/**/*.py`

## Runtime checks

- Kind: `validator`
- Severity: `warning`
- Scope: `file`

## Related conventions

- [python-module-boundaries](opencanon://conventions/python-module-boundaries)
