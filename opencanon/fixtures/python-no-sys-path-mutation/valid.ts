import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.py("src/python/etl/reporting.py", `
      from collections.abc import Iterable


      def summarize(values: Iterable[int]) -> int:
          return sum(values)
    `),
  ],
});
