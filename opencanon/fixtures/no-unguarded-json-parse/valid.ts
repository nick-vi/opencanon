import { defineFixture } from "@opencanon/core/testing";

/**
 * Guarded parse: JSON.parse of file I/O sits inside a try/catch, so a malformed
 * file degrades to a null default instead of crashing. Expect zero findings.
 */
export default defineFixture({
  files: ({ file }) => [
    file.ts("packages/app/src/load-config.ts", `
      import { readFileSync } from "node:fs";

      export function loadConfig(path: string): Record<string, unknown> | null {
        try {
          return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    `),
  ],
});
