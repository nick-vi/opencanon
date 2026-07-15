import assert from "node:assert/strict";
import { test } from "vitest";
import { indexRuntimeCodeGraph, type RuntimeFactFile } from "../src/project-source-snapshot.ts";
import type { ProjectStore } from "../src/state.ts";

test("runtime graph indexing sends the complete indexable source inventory", async () => {
  let request: unknown;
  const store = {
    project: {
      async indexCodeGraph(input: unknown) {
        request = input;
        return { indexed: [], deleted: [], diagnostics: [], parserVersion: "parser", extractorVersion: "extractor" };
      },
    },
  } as unknown as ProjectStore;
  const factFiles: RuntimeFactFile[] = [
    { path: "src/changed.ts", contentHash: "changed", language: "typescript", content: "export const changed = true;" },
    { path: "src/unchanged.ts", contentHash: "unchanged", language: "typescript", content: "export const unchanged = true;" },
    { path: "src/App.svelte", contentHash: "component", language: "svelte", content: "<p>App</p>" },
  ];

  await indexRuntimeCodeGraph({
    store,
    factFiles,
  });

  assert.deepEqual(request, {
    files: [factFiles[0], factFiles[1]],
    parserVersion: "oxc-0.128.0",
  });
});
