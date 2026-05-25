import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("packages/billing/src/db/dal/invoice.ts", `
      export async function findInvoiceById(id: string): Promise<{ id: string } | null> {
        return { id };
      }
    `),
    file.ts("packages/billing/src/services/invoice.service.ts", `
      import { findInvoiceById } from "../db/dal/invoice.ts";

      export async function getInvoice(id: string) {
        return findInvoiceById(id);
      }
    `),
    file.ts("src/db/dal/company.ts", `
      export async function findCompanyById(id: string): Promise<{ id: string }> {
        return { id };
      }
    `),
    file.ts("src/services/company.service.ts", `
      import { findCompanyById } from "../db/dal/company.ts";

      export async function getCompany(id: string) {
        return findCompanyById(id);
      }
    `),
  ],
});
