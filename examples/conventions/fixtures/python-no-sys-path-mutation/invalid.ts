import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.py("src/python/etl/reporting.py", `
      import sys

      sys.path.append("../../")

      from shared.metrics import total


      def summarize(values: list[int]) -> int:
          return total(values)
    `),
  ],
});
