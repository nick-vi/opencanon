import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/services/company.service.ts", `
      // Legacy shim for callers that still pass blank names.
      export function normalizeCompanyName(name: string): string {
        return name.trim();
      }
    `),
  ],
});
