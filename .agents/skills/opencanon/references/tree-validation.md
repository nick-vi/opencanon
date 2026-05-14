# Tree Validation

Use `ctx.tree()` for mechanically checkable project structure rules.

## Path Rules

Tree keys are path globs. `children` keys are relative to the parent path and can also use globs.

```ts
validate({ ctx }) {
  return ctx.tree({
    "src": {
      folders: {
        denyNames: ["misc", "common"],
      },
      children: {
        "services": {
          files: {
            match: "**/*.{ts,tsx}",
            suffix: [".service.ts", ".service.tsx"],
            allowNames: ["index.ts", "index.tsx"],
          },
          imports: {
            maxRelativeDepth: 1,
          },
        },
      },
    },
    "packages/*/src": {
      children: {
        "services": {
          files: {
            match: "**/*.{ts,tsx}",
            suffix: [".service.ts", ".service.tsx"],
            allowNames: ["index.ts", "index.tsx"],
          },
        },
      },
    },
  });
}
```

## Named Boundaries

Use `nodes` and `boundaries` when dependency policy reads better as a graph.

```ts
validate({ ctx }) {
  return ctx.tree({
    nodes: {
      routes: ["src/api/routes/**/*.{ts,tsx}", "packages/*/src/api/routes/**/*.{ts,tsx}"],
      services: ["src/services/**/*.{ts,tsx}", "packages/*/src/services/**/*.{ts,tsx}"],
      dal: ["src/db/dal/**/*.{ts,tsx}", "packages/*/src/db/dal/**/*.{ts,tsx}"],
      dbClient: ["src/db/client.ts", "packages/*/src/db/client.ts"],
    },
    boundaries: [
      { from: "routes", allow: ["services"] },
      { from: "routes", deny: ["dal", "dbClient"] },
      { from: "services", deny: ["dbClient"] },
    ],
  });
}
```

Use `paths` when combining path rules and named boundaries:

```ts
ctx.tree({
  paths: {
    "src": {
      children: {
        "services": {
          files: { suffix: [".service.ts"], allowNames: ["index.ts"] },
        },
      },
    },
  },
  nodes: {
    services: "src/services/**/*.{ts,tsx}",
    dbClient: "src/db/client.ts",
  },
  boundaries: [{ from: "services", deny: ["dbClient"] }],
});
```

## Rules

- Missing folders are allowed by default.
- Tree definitions are validated at runtime; invalid definitions emit findings.
- File rename fixes should stay `manual` until import rewrites are implemented.
- Prefer tree rules for folder naming, file suffixes, import boundaries, and relative import depth.
- Use custom validator code for domain-specific AST or runtime-call checks.
