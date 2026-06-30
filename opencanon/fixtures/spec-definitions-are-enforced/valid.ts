import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("opencanon/specs/index.ts", "export default [];\n"),
  ],
});
