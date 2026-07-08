import { defineFixture } from "@opencanon/core/testing";

const routeHandlers = Array.from({ length: 925 }, (_, index) => `export function route${index}() { return ${index}; }`).join("\n");

export default defineFixture({
  files: ({ file }) => [
    file.ts("packages/runtime/src/large-router.ts", routeHandlers),
  ],
});
