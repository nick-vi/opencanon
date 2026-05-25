import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.py("src/python/etl/reporting.py", `
      def load_report():
          try:
              return "ok"
          except:
              return "fallback"
    `),
  ],
});
