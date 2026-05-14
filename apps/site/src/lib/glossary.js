export const GLOSSARY = {
  canon:
    'The project rules OpenCanon can show to humans and agents.',
  facts:
    'Structured data from source files, such as imports, exports, comments, calls, and literals.',
  decisions:
    'Records that explain a rule, why it exists, and which validators enforce it.',
  validators:
    'TypeScript rules that read facts and return findings.',
  findings:
    'Actionable results with severity, rule id, file location, and optional fixes.',
  daemon:
    'A local process that watches the repo, caches facts, runs validators, and serves the CLI, hooks, and UI.',
  register:
    'A named list of decisions or terms.',
  oxc:
    'The Oxc parser OpenCanon uses for JavaScript and TypeScript.'
};
