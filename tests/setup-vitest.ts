import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { setProjectAstFactsProviderFactory } from "@opencanon/core";
import { createCliAstFactsProvider } from "@opencanon/runtime";

let astFacts: ReturnType<typeof createCliAstFactsProvider> | undefined;
const previousServiceOwnerPid = process.env.OPENCANON_SERVICE_OWNER_PID;

beforeAll(() => {
  process.env.OPENCANON_SERVICE_OWNER_PID = String(process.pid);
});

afterAll(() => {
  if (previousServiceOwnerPid === undefined) delete process.env.OPENCANON_SERVICE_OWNER_PID;
  else process.env.OPENCANON_SERVICE_OWNER_PID = previousServiceOwnerPid;
});

beforeEach(() => {
  astFacts = createCliAstFactsProvider();
  setProjectAstFactsProviderFactory(astFacts.factory);
});

afterEach(() => {
  setProjectAstFactsProviderFactory(undefined);
  astFacts?.dispose();
  astFacts = undefined;
});
