# Language Python

## Python

Python modules use normal package imports.

Rules:

- Do not mutate `sys.path` inside source modules.
- Put dependency setup in the runner, test config, or package metadata.
- Keep imports at module top level unless a local import prevents a real cycle.
- Prefer explicit package imports over path-relative runtime tricks.
- Catch specific exception types instead of using bare `except:`.
