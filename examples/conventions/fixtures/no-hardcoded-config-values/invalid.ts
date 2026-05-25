import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/config.ts", `
      export const callbackUrl = "https://api.example.com/callback";
      export const publicPort = 8080;
    `),
  ],
});
