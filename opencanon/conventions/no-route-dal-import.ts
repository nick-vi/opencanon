import { noImports } from "@opencanon/validators";

const validator = noImports({
  id: "no-route-dal-import",
  title: "Routes call services instead of DAL modules",
  topics: ["api-route"],
  from: ["src/api/routes/**/*.{ts,tsx}", "packages/*/src/api/routes/**/*.{ts,tsx}"],
  to: ["src/db/dal/**/*.{ts,tsx}", "packages/*/src/db/dal/**/*.{ts,tsx}", "**/db/dal/**", "src/db/client.ts", "packages/*/src/db/client.ts", "**/db/client"],
  severity: "error",
  related: ["dal-transaction-flow"],
  message: "Route handlers must call services, not DAL modules.",
  fix: {
    safety: "manual",
    description: "Move persistence workflow into a service and inject/call that service from the route.",
  },
  docs: ["docs/opencanon/canon/no-route-dal-import.md#routes-call-services-instead-of-dal-modules"],
});

export default validator;
