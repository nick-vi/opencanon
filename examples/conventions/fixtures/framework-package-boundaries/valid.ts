import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("packages/cli/src/index.ts", `
      import { startOpenCanonDaemon } from "@opencanon/daemon";
      import { fail } from "@opencanon/core";

      export const cliValue = { fail, startOpenCanonDaemon };
    `),
    file.ts("packages/core/src/index.ts", `
      export function defineCoreValue() {
        return "core";
      }
    `),
    file.ts("packages/daemon/src/index.ts", `
      import { createOpenCanonDiagnostic } from "@opencanon/core";
      import { loadEngine } from "@opencanon/engine";
      import { noImports } from "@opencanon/validators";

      export const daemonValue = { createOpenCanonDiagnostic, loadEngine, noImports };
    `),
    file.tsx("packages/ui/src/App.tsx", `
      import { apiGet } from "./api";

      export function App() {
        return apiGet();
      }
    `),
    file.ts("packages/ui/src/api.ts", `
      export function apiGet() {
        return null;
      }
    `),
    file.ts("packages/validators/src/index.ts", `
      import { defineValidator } from "@opencanon/core";

      export const validator = defineValidator({
        id: "valid-validator",
        validate() {
          return [];
        },
      });
    `),
  ],
});
