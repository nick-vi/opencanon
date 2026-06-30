import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/services/company.service.ts", `
      // Keep this check near the workflow because it mirrors the domain rule.
      export function normalizeCompanyName(name: string): string {
        return name.trim();
      }
    `),
  ],
});
