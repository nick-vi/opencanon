import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/features/company/format.ts", `
      export function formatCompanyName(name: string): string {
        return name.trim();
      }
    `),
    file.ts("src/features/company/index.ts", `
      import { formatCompanyName } from "./format.ts";

      export function labelCompany(name: string): string {
        return formatCompanyName(name);
      }
    `),
  ],
});
