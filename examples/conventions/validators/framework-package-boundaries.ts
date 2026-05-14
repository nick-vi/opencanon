import { defineValidator } from "../../../.agents/skills/opencanon/index.ts";

const packageNodes = {
  cli: "packages/cli/src/**/*.{ts,tsx}",
  core: "packages/core/src/**/*.{ts,tsx}",
  daemon: "packages/daemon/src/**/*.{ts,tsx}",
  engine: "packages/engine/src/**/*.{ts,tsx}",
  ui: "packages/ui/src/**/*.{ts,tsx}",
  validators: "packages/validators/src/**/*.{ts,tsx}",
} as const;

const docs = ["examples/conventions/docs/opencanon/decisions.json#framework-package-boundaries"];

const validator = defineValidator({
  id: "framework-package-boundaries",
  topics: ["imports", "folder-structure"],
  applies: ["packages/*/src/**/*.{ts,tsx}"],
  severity: "error",
  scope: "import-edge",
  facts: ["imports"],
  decisionIds: ["framework-package-boundaries"],
  docs,
  summary: "OpenCanon framework packages must depend only on approved lower-level packages.",
  visuals: [
    {
      kind: "tree",
      title: "Framework Package Boundaries",
      definition: {
        nodes: packageNodes,
        boundaries: [
          { from: "core", deny: ["cli", "daemon", "engine", "ui", "validators"], docs },
          { from: "validators", allow: ["core"], docs },
          { from: "engine", allow: ["core"], docs },
          { from: "daemon", allow: ["core", "engine", "validators"], docs },
          { from: "cli", allow: ["core", "daemon"], docs },
          { from: "ui", deny: ["cli", "core", "daemon", "engine", "validators"], docs },
        ],
      },
    },
  ],
  validate({ ctx }) {
    return ctx.tree({
      nodes: packageNodes,
      boundaries: [
        {
          from: "core",
          deny: ["cli", "daemon", "engine", "ui", "validators"],
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
          from: "engine",
          allow: ["core"],
          message: "Engine TypeScript wrapper may only depend on core and local engine modules.",
          docs,
        },
        {
          from: "daemon",
          allow: ["core", "engine", "validators"],
          message: "Daemon may only depend on core, engine, validators, and local daemon modules.",
          docs,
        },
        {
          from: "cli",
          allow: ["core", "daemon"],
          message: "CLI may only depend on core, daemon, and local CLI modules.",
          docs,
        },
        {
          from: "ui",
          deny: ["cli", "core", "daemon", "engine", "validators"],
          message: "UI source must not import framework runtime packages directly.",
          docs,
        },
      ],
    });
  },
});

export default validator;
