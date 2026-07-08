# Python catches specific exception types

## Rule

Python code should catch specific exception types instead of using bare except clauses.

## Applies to

- `src/python/**/*.py`

## Runtime checks

- Kind: `validator`
- Severity: `warning`
- Scope: `file`

## Related conventions

- [Python modules use package imports instead of sys.path mutation](python-module-boundaries.md)
