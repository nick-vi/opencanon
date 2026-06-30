# Robustness

## Guard File JSON Parse

Parsing file contents with `JSON.parse` must sit inside a `try`/`catch` so malformed local state degrades gracefully instead of crashing the process.
