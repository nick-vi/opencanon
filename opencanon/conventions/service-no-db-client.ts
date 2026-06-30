import { noImports } from "@opencanon/validators";

const validator = noImports({
  id: "service-no-db-client",
  title: "Services do not import DB clients",
  topics: ["service", "dal"],
  from: ["src/services/**/*.{ts,tsx}", "packages/*/src/services/**/*.{ts,tsx}"],
  to: ["src/db/client.ts", "packages/*/src/db/client.ts", "src/db/schema/**", "packages/*/src/db/schema/**"],
  severity: "error",
  related: ["dal-transaction-flow", "service-db-boundary"],
  message: "Services must not import DB clients directly.",
  fix: {
    safety: "manual",
    description: "Move query construction into a DAL function and call that function from the service.",
  },
  docs: ["docs/opencanon/canon/service-no-db-client.md#services-do-not-import-db-clients"],
});

export default validator;
