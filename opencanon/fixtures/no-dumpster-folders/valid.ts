import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/services/company.service.ts", `
      export function normalizeCompanyName(name: string): string {
        return name.trim();
      }
    `),
  ],
});
