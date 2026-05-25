import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("packages/core/src/index.ts", `
      import { startOpenCanonDaemon } from "../../daemon/src/index";

      export const badCoreDependency = startOpenCanonDaemon;
    `),
    file.tsx("packages/ui/src/App.tsx", `
      import { createOpenCanonDiagnostic } from "../../core/src/index";

      export const badUiDependency = createOpenCanonDiagnostic;
    `),
  ],
});
