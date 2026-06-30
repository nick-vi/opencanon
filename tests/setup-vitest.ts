import { afterEach, beforeEach } from "vitest";
import { setProjectAstFactsProviderFactory } from "@opencanon/core";
import { createCliAstFactsProvider } from "@opencanon/runtime";

let astFacts: ReturnType<typeof createCliAstFactsProvider> | undefined;

beforeEach(() => {
  astFacts = createCliAstFactsProvider();
  setProjectAstFactsProviderFactory(astFacts.factory);
});

afterEach(() => {
  setProjectAstFactsProviderFactory(undefined);
  astFacts?.dispose();
  astFacts = undefined;
});
