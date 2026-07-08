# Python modules use package imports instead of sys.path mutation

## Rule

Python code should use normal package/module configuration rather than mutating sys.path at runtime.

## Applies to

- `src/python/**/*.py`

## Why

Runtime path mutation hides dependency boundaries. Package imports are easier for tests, agents, and tooling to reason about.

## Related conventions

- [Python modules do not mutate sys.path](python-no-sys-path-mutation.md)
- [Python catches specific exception types](python-no-bare-except.md)
