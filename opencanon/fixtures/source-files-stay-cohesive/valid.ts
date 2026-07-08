import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("packages/runtime/src/router.ts", `
      export function route() {
        return { ok: true };
      }
    `),
  ],
});
