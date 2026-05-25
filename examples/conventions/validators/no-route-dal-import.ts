import { noImports } from "@opencanon/validators";

const validator = noImports({
  id: "no-route-dal-import",
  topics: ["api-route"],
  from: ["src/api/routes/**/*.{ts,tsx}", "packages/*/src/api/routes/**/*.{ts,tsx}"],
  to: ["src/db/dal/**/*.{ts,tsx}", "packages/*/src/db/dal/**/*.{ts,tsx}", "**/db/dal/**", "src/db/client.ts", "packages/*/src/db/client.ts", "**/db/client"],
  severity: "error",
  decisionIds: ["dal-transaction-flow"],
  message: "Route handlers must call services, not DAL modules.",
  fix: {
    safety: "manual",
    description: "Move persistence workflow into a service and inject/call that service from the route.",
  },
  docs: ["examples/conventions/docs/opencanon/decisions.json#dal-transaction-flow"],
});

export default validator;
