import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("packages/runtime/src/server.ts", `
      import { diagnosticsFailure, json } from "./routes.ts";

      export function route() {
        return json(diagnosticsFailure(["Invalid request."]), 400);
      }

      export function internalParser() {
        const diagnostics = [];
        return { ok: false, diagnostics };
      }
    `),
    file.ts("packages/cli/src/runtime-client.ts", `
      export async function unwrap(response: Response) {
        const payload = await response.json();
        if (!payload.ok) throw new Error(payload.error.kind);
        return payload.data;
      }
    `),
  ],
});
