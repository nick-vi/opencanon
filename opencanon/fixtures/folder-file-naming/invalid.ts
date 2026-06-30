import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("packages/billing/src/services/invoice.ts", `
      export async function getInvoice(id: string): Promise<{ id: string } | null> {
        return { id };
      }
    `),
    file.ts("src/services/company.ts", `
      export async function getCompany(id: string): Promise<{ id: string } | null> {
        return { id };
      }
    `),
  ],
});
