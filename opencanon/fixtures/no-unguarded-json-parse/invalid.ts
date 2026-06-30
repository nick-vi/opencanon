import { defineFixture } from "@opencanon/core/testing";

/**
 * Unguarded parse: JSON.parse of file I/O is NOT inside a try/catch, so a
 * malformed file throws a SyntaxError and crashes. Expect at least one finding.
 */
export default defineFixture({
  files: ({ file }) => [
    file.ts("packages/app/src/load-config.ts", `
      import { readFileSync } from "node:fs";

      export function loadConfig(path: string): Record<string, unknown> {
        return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      }
    `),
  ],
});
