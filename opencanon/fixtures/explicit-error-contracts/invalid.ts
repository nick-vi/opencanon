import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("packages/runtime/src/server.ts", `
      import { json } from "./routes.ts";

      export function route() {
        return json({ ok: false, diagnostics: [{ message: "Invalid request." }] }, 400);
      }
    `),
    file.ts("packages/cli/src/runtime-client.ts", `
      export async function unwrap(response: Response) {
        const payload = await response.json();
        if (!payload.ok) throw new Error(payload.diagnostics.map((item) => item.message).join("\\n"));
        return payload.data;
      }
    `),
  ],
});
