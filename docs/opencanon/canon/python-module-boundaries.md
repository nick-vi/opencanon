# Python modules use package imports instead of sys.path mutation

Convention id: `python-module-boundaries`.
Render style: `reference`.

## Rule

Rule: Python code should use normal package/module configuration rather than mutating sys.path at runtime.

## Applies to

Kind: `files`
- file glob `src/python/**/*.py`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: Runtime path mutation hides dependency boundaries. Package imports are easier for tests, agents, and tooling to reason about.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [python-no-sys-path-mutation](opencanon://conventions/python-no-sys-path-mutation)
- [python-no-bare-except](opencanon://conventions/python-no-bare-except)
