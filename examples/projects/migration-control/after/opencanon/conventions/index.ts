import { migrationReferences } from "@opencanon/validators";

export default [
  migrationReferences({
    id: "migration-control",
    title: "Migration control",
    topics: ["migration", "deprecation"],
    why: "Agents need a clear boundary between existing migration debt and newly introduced drift.",
    rule: "Known migration debt may warn from the baseline, but new replaced API usage fails validation.",
    in: ["src/**/*.ts"],
    pattern: "\\boldApi\\(",
    replacement: "currentApi(",
    fixSafety: "suggested",
    message: "oldApi is replaced; use currentApi.",
    render: { kind: "generated", docs: "docs/opencanon/canon/migrations.md", style: "reference" },
    severity: "error",
  }),
];
