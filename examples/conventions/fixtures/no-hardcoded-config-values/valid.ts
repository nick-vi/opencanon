import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/config.ts", `
      export const LocalDefaults = {
        host: "127.0.0.1",
        port: 4767,
      } as const;
    `),
  ],
});
