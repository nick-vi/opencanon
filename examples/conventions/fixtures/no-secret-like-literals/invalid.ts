import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/config.ts", `
      export const apiKey = "not-a-real-secret-value";
    `),
  ],
});
