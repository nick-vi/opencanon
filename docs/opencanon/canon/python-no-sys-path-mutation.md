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

- [python-module-boundaries](opencanon://conventions/python-module-boundaries)
