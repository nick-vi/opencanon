# Python modules do not mutate sys.path

## Rule

Python modules should not mutate sys.path to cross package boundaries.

## Applies to

- `src/python/**/*.py`

## Runtime checks

- Kind: `validator`
- Severity: `warning`
- Scope: `file`

## Related conventions

- [Python modules use package imports instead of sys.path mutation](python-module-boundaries.md)
