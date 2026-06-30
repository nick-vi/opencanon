import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("packages/cli/src/index.ts", `
      import { startOpenCanonRuntime } from "@opencanon/runtime";
      import { fail } from "@opencanon/core";

      export const cliValue = { fail, startOpenCanonRuntime };
    `),
    file.ts("packages/core/src/index.ts", `
      export function defineCoreValue() {
        return "core";
      }
    `),
    file.ts("packages/runtime/src/index.ts", `
      import { createOpenCanonDiagnostic } from "@opencanon/core";
      import { requiredNodeRequirement } from "@opencanon/distribution";
      import { loadEngine } from "@opencanon/engine";
      import { noImports } from "@opencanon/validators";

      export const runtimeValue = { createOpenCanonDiagnostic, requiredNodeRequirement, loadEngine, noImports };
    `),
    file.ts("packages/distribution/src/index.ts", `
      import { createOpenCanonDiagnostic } from "@opencanon/core";
      import { engineBindingName } from "@opencanon/engine";

      export const distributionValue = { createOpenCanonDiagnostic, engineBindingName };
    `),
    file.ts("packages/validators/src/index.ts", `
      import { defineConvention } from "@opencanon/core";

      export const convention = defineConvention({
        id: "valid-validator",
        title: "Valid Validator",
        rule: "valid",
        applies: { kind: "files", globs: ["src/**"] },
        render: { kind: "none" },
        runtime: { kind: "validator", severity: "warning", scope: "project", facts: [], validate() { return []; } },
      });
    `),
  ],
});
