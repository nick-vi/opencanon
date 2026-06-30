import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.md("README.md", `
      # OpenCanon

      Project Canon keeps Proof, Knowledge, Activity, Areas, Specs, Changes, Surfaces, Search, Doctor, and Health aligned.
    `),
  ],
});
