import { defineConvention } from "@opencanon/core";
import type { Finding, ValidatorRuntime } from "@opencanon/core";

const docs = ["docs/opencanon/canon/source-files-stay-cohesive.md#source-files-keep-one-primary-responsibility"];

const sourceGlobs = [
  "apps/site/src/**/*.{svelte,ts,js}",
  "crates/*/src/**/*.rs",
  "opencanon/**/*.ts",
  "packages/*/src/**/*.{ts,tsx,js,jsx,mts,cts}",
  "packages/*/test/**/*.{ts,tsx,js,jsx,mts,cts}",
  "scripts/**/*.{ts,tsx,mts,cts}",
  "tests/**/*.{ts,tsx,js,jsx,mts,cts}",
] as const;

const ignoredGlobs = [
  "**/*.d.ts",
  "**/*.generated.*",
  "**/generated/**",
  "**/target/**",
  "opencanon/fixtures/**",
] as const;

type CohesionThreshold = {
  label: string;
  maxNonBlankLines: number;
};

const SourceCohesionThreshold = {
  ApplicationSource: { label: "application source", maxNonBlankLines: 900 },
  RustSource: { label: "Rust source", maxNonBlankLines: 1200 },
  TestSource: { label: "test source", maxNonBlankLines: 1800 },
} as const satisfies Record<string, CohesionThreshold>;

function thresholdFor(runtime: ValidatorRuntime, filePath: string): CohesionThreshold {
  if (
    runtime.matches(filePath, [
      "crates/*/src/**/test*.rs",
      "crates/*/src/**/tests.rs",
      "packages/*/src/**/*.test.{ts,tsx,js,jsx,mts,cts}",
      "packages/*/test/**",
      "tests/**",
    ])
  ) {
    return SourceCohesionThreshold.TestSource;
  }
  if (runtime.matches(filePath, ["crates/*/src/**/*.rs"])) return SourceCohesionThreshold.RustSource;
  return SourceCohesionThreshold.ApplicationSource;
}

function nonBlankLineCount(lines: readonly string[]): number {
  return lines.filter((line) => line.trim().length > 0).length;
}

const convention = defineConvention({
  id: "source-files-stay-cohesive",
  title: "Source files keep one primary responsibility",
  topics: ["maintainability", "architecture", "testing"],
  related: ["folder-structure-current", "import-boundaries-current", "tests-follow-risk"],
  why: "Large mixed-responsibility files hide ownership boundaries, slow reviews, and make agent edits riskier because unrelated behavior shares one edit surface.",
  rule: "Source files should stay cohesive. A large file should be split once it combines lifecycle, routing, storage, rendering, validation, or unrelated test concerns.",
  examples: [
    { note: "Split a runtime service file into registry, lifecycle, reconcile, and HTTP adapter modules when those responsibilities grow independently." },
    { note: "Keep long test suites grouped by behavior instead of using one catch-all test file for unrelated runtime, doctor, cache, and CLI checks." },
    { note: "Generated files and fixtures are excluded; the rule is about authored source ownership." },
  ],
  applies: { kind: "files", globs: [...sourceGlobs] },
  render: { kind: "generated", docs: "docs/opencanon/canon/source-files-stay-cohesive.md", style: "reference" },
  runtime: {
    kind: "validator",
    severity: "warning",
    scope: "file",
    facts: [],
    fixtures: "valid-and-invalid",
    validate({ ctx, runtime }) {
      const findings: Finding[] = [];
      for (const file of ctx.targetFiles) {
        if (runtime.matches(file.path, [...ignoredGlobs])) continue;
        const threshold = thresholdFor(runtime, file.path);
        const lines = nonBlankLineCount(file.lines);
        if (lines <= threshold.maxNonBlankLines) continue;
        findings.push(
          file.report({
            line: 1,
            message: `${file.path} has ${lines} nonblank lines, above the ${threshold.maxNonBlankLines}-line ${threshold.label} cohesion threshold.`,
            docs,
            fix: {
              safety: "manual",
              description: "Split the file by responsibility, or make the next change extract a coherent module before adding more behavior here.",
            },
          }),
        );
      }
      return findings;
    },
  },
});

export default convention;
