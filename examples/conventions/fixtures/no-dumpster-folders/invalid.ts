import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("packages/billing/src/common/invoice.ts", `
      export function normalizeInvoiceId(id: string): string {
        return id.trim();
      }
    `),
    file.ts("src/misc/company.ts", `
      export function normalizeCompanyName(name: string): string {
        return name.trim();
      }
    `),
  ],
});
