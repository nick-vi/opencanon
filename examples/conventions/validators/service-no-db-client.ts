import { noImports } from "@opencanon/validators";

const validator = noImports({
  id: "service-no-db-client",
  topics: ["service", "dal"],
  from: ["src/services/**/*.{ts,tsx}", "packages/*/src/services/**/*.{ts,tsx}"],
  to: ["src/db/client.ts", "packages/*/src/db/client.ts", "src/db/schema/**", "packages/*/src/db/schema/**"],
  severity: "error",
  decisionIds: ["dal-transaction-flow", "service-db-boundary"],
  message: "Services must not import DB clients directly.",
  fix: {
    safety: "manual",
    description: "Move query construction into a DAL function and call that function from the service.",
  },
  docs: ["examples/conventions/docs/opencanon/decisions.json#dal-transaction-flow", "examples/conventions/docs/opencanon/decisions.json#service-db-boundary"],
});

export default validator;
