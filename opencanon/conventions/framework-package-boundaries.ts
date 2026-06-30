import { defineConvention } from "@opencanon/core";

const packageNodes = {
  serviceContracts: "packages/service-contracts/src/**/*.{ts,tsx}",
  cli: "packages/cli/src/**/*.{ts,tsx}",
  core: "packages/core/src/**/*.{ts,tsx}",
  distribution: "packages/distribution/src/**/*.{ts,tsx}",
  runtime: "packages/runtime/src/**/*.{ts,tsx}",
  engine: "packages/engine/src/**/*.{ts,tsx}",
  observability: "packages/observability/src/**/*.{ts,tsx}",
  validators: "packages/validators/src/**/*.{ts,tsx}",
} as const;

const docs = ["docs/opencanon/canon/framework-package-boundaries.md#framework-packages-depend-inward"];

const convention = defineConvention({
  id: "framework-package-boundaries",
  title: "Framework packages depend inward",
  topics: ["imports", "folder-structure"],
  related: ["framework-package-boundaries"],
  rule: "OpenCanon framework packages must depend only on approved lower-level packages.",
  applies: { kind: "imports", from: ["packages/*/src/**/*.{ts,tsx}"] },
  render: { kind: "generated", docs: "docs/opencanon/canon/framework-package-boundaries.md", style: "reference" },
  runtime: {
    kind: "validator",
    severity: "error",
    scope: "import-edge",
    facts: ["imports"],
    visuals: [
      {
        kind: "tree",
        title: "Framework packages depend inward",
        definition: {
          nodes: packageNodes,
          boundaries: [
            { from: "serviceContracts", allow: [], docs },
            { from: "core", deny: ["cli", "runtime", "engine", "validators"], docs },
            { from: "validators", allow: ["core"], docs },
            { from: "observability", allow: [], docs },
            { from: "engine", allow: ["serviceContracts", "core", "observability"], docs },
            { from: "distribution", allow: ["serviceContracts", "core", "engine"], docs },
            { from: "runtime", allow: ["serviceContracts", "core", "distribution", "engine", "observability", "validators"], docs },
            { from: "cli", allow: ["serviceContracts", "core", "distribution", "runtime"], docs },
          ],
        },
      },
    ],
    validate({ ctx }) {
      return ctx.tree({
        nodes: packageNodes,
        boundaries: [
          {
            from: "serviceContracts",
            allow: [],
            message: "Service contracts must stay dependency-free.",
            docs,
          },
          {
            from: "core",
            deny: ["cli", "distribution", "runtime", "engine", "observability", "validators"],
            message: "Core must not depend on higher-level framework packages.",
            docs,
          },
          {
            from: "validators",
            allow: ["core"],
            message: "Validator factories may only depend on core and local validator modules.",
            docs,
          },
          {
            from: "observability",
            allow: [],
            message: "Observability must not depend on framework packages.",
            docs,
          },
          {
            from: "engine",
            allow: ["serviceContracts", "core", "observability"],
            message: "Engine TypeScript wrapper may only depend on core, observability, and local engine modules.",
            docs,
          },
          {
            from: "distribution",
            allow: ["serviceContracts", "core", "engine"],
            message: "Distribution may only depend on core, engine, and local distribution modules.",
            docs,
          },
          {
            from: "runtime",
            allow: ["serviceContracts", "core", "distribution", "engine", "observability", "validators"],
            message: "The service/runtime package may only depend on core, distribution, engine, observability, validators, and local service/runtime modules.",
            docs,
          },
          {
            from: "cli",
            allow: ["serviceContracts", "core", "distribution", "runtime"],
            message: "CLI may only depend on core, distribution, the service/runtime package, and local CLI modules.",
            docs,
          },
        ],
      });
    },
  },
});

export default convention;
