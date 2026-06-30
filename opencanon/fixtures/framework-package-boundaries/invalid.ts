import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.json("package.json", { workspaces: ["packages/*"] }, { target: false }),
    file.json("packages/service-contracts/package.json", { name: "@opencanon/service-contracts", exports: { ".": "./src/index.ts" } }, { target: false }),
    file.json("packages/core/package.json", { name: "@opencanon/core", exports: { ".": "./src/index.ts" } }, { target: false }),
    file.json("packages/runtime/package.json", { name: "@opencanon/runtime", exports: { ".": "./src/index.ts" } }, { target: false }),
    file.json("packages/distribution/package.json", { name: "@opencanon/distribution", exports: { ".": "./src/index.ts" } }, { target: false }),
    file.ts("packages/service-contracts/src/index.ts", `
      import { createOpenCanonDiagnostic } from "@opencanon/core";

      export const badServiceContractDependency = createOpenCanonDiagnostic;
    `),
    file.ts("packages/runtime/src/index.ts", `
      export function startOpenCanonRuntime() {
        return "runtime";
      }
    `, { target: false }),
    file.ts("packages/core/src/index.ts", `
      import { startOpenCanonRuntime } from "@opencanon/runtime";

      export const badCoreDependency = startOpenCanonRuntime;
    `),
    file.ts("packages/distribution/src/index.ts", `
      import { startOpenCanonRuntime } from "@opencanon/runtime";

      export const badDistributionDependency = startOpenCanonRuntime;
    `),
  ],
});
