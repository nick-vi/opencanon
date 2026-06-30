import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.md("README.md", `
      # OpenCanon

      Capabilities and Work live next to Semantic search in agent docs.
    `),
  ],
});
