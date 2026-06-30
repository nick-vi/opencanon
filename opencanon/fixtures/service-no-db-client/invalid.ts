import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("packages/billing/src/db/client.ts", `
      export function db() {
        return {
          select() {
            return [{ id: "invoice_1" }];
          },
        };
      }
    `),
    file.ts("packages/billing/src/services/invoice.service.ts", `
      import { db } from "../db/client.ts";

      export async function getInvoice(id: string) {
        const rows = await db().select();
        return rows.find((row) => row.id === id) ?? null;
      }
    `),
    file.ts("src/db/client.ts", `
      export function db() {
        return {
          select() {
            return {
              where(_input: unknown) {
                return [{ id: "company_1" }];
              },
            };
          },
        };
      }
    `),
    file.ts("src/services/company.service.ts", `
      import { db } from "../db/client.ts";

      export async function getCompany(id: string) {
        const rows = await db().select().where({ id });
        return rows[0] ?? null;
      }
    `),
  ],
});
