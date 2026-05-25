import { noImports } from "@opencanon/validators";

const validator = noImports({
  id: "no-db-schema-in-contracts",
  topics: ["architecture", "schema"],
  from: ["src/contracts/**/*.{ts,tsx}", "packages/*/src/contracts/**/*.{ts,tsx}"],
  to: ["src/db/schema/**", "packages/*/src/db/schema/**", "**/db/schema/**"],
  severity: "error",
  decisionIds: ["schema-contract-boundary"],
  message: "Public contract modules must not import database schema internals.",
  fix: {
    safety: "manual",
    description: "Move persistence details behind DAL/service translation and keep DTO contracts independent.",
  },
  docs: ["examples/conventions/docs/opencanon/canon/architecture.md#schemas"],
});

export default validator;
