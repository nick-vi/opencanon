import { defineCanonBundle } from "../../packages/core/src/bundles.ts";

export default defineCanonBundle({
  id: "migration-control",
  description: "Adds a migration validator that blocks new usage of a replaced API while allowing baselined existing usage to warn.",
  topics: ["migration", "deprecation"],
  validators: ["old-api-migration"],
  options: {
    sourceGlobs: {
      type: "string[]",
      default: ["src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
      description: "Source globs checked by the migration validator.",
    },
    oldPattern: {
      type: "string",
      required: true,
      description: "Regular expression for the replaced API or pattern.",
    },
    replacement: {
      type: "string",
      required: true,
      description: "Replacement text used for the suggested structured fix.",
    },
    validatorId: {
      type: "string",
      default: "old-api-migration",
      description: "Validator id written into the installed validator module.",
    },
  },
  docs: [
    {
      path: "docs/opencanon/canon/migrations.md",
      heading: "Migration Control",
      body: [
        "Migrations block new usage of replaced APIs while existing usage can remain visible as baseline-managed debt.",
        "",
        "Rules:",
        "",
        "- Add replaced APIs as explicit migration validators.",
        "- Keep existing matches in the baseline when a one-shot cleanup is not practical.",
        "- Treat new matches as errors.",
        "- Prefer structured replacement fixes when the replacement is mechanical.",
      ].join("\n"),
    },
  ],
  decisions: [
    {
      id: "migration-control-current",
      date: "2026-05-20",
      status: "current",
      title: "Migration validators block new replaced API usage",
      topics: ["migration", "deprecation"],
      applies: ["src/**", "packages/*/src/**"],
      summary: "Known migration debt may warn from the baseline, but new usage of replaced APIs fails validation.",
      rationale: ["Agents need a clear boundary between existing migration debt and newly introduced drift."],
      required: ["Use migrationReferences for replaced APIs that should not grow."],
      replaced: [],
      agentPolicy: ["Do not introduce replaced API usage. Use the configured replacement or ask before changing the migration target."],
      exceptions: [],
      docs: ["docs/opencanon/canon/migrations.md#migration-control"],
      validatorIds: ["{{validatorId}}"],
    },
  ],
  files: [
    {
      path: ".agents/skills/opencanon/validators/migration-control.ts",
      content: `import { migrationReferences } from "../index.ts";

export default migrationReferences({
  id: "{{validatorId}}",
  topics: ["migration", "deprecation"],
  severity: "error",
  in: "{{sourceGlobs}}".split(",").map((item) => item.trim()).filter(Boolean),
  pattern: "{{oldPattern}}",
  replacement: "{{replacement}}",
  fixSafety: "suggested",
  existingSeverity: "warning",
  newSeverity: "error",
  message: "Replaced API usage must not be introduced.",
  docs: ["docs/opencanon/canon/migrations.md#migration-control"],
});
`,
    },
    {
      path: ".agents/skills/opencanon/fixtures/old-api-migration/valid/src/current.ts",
      content: "currentApi();\n",
    },
    {
      path: ".agents/skills/opencanon/fixtures/old-api-migration/invalid/src/old.ts",
      content: "oldApi();\n",
    },
  ],
  impactSurfaces: [],
  externalTools: {},
});
