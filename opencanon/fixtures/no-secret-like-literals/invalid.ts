import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/config.ts", `
      export const apiKey = "not-a-real-secret-value";
    `),
    file.ts("packages/core/src/release-keys.ts", `
      export const privateKey = "-----BEGIN PRIVATE KEY-----";
    `),
  ],
});
