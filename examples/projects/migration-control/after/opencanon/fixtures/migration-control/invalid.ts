import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/orders.ts", `
      export function submitOrder(input: { total: number }) {
        return oldApi(input);
      }

      function oldApi(input: { total: number }) {
        return { ok: true, total: input.total };
      }
    `),
  ],
});
