import { duplicateBoundaryLiterals } from "@opencanon/validators";

const validator = duplicateBoundaryLiterals({
  id: "duplicate-boundary-literals",
  topics: ["maintainability", "schema"],
  in: ["src/api/routes/**/*.{ts,tsx}", "src/contracts/**/*.{ts,tsx}", "packages/*/src/api/routes/**/*.{ts,tsx}", "packages/*/src/contracts/**/*.{ts,tsx}"],
  severity: "warning",
  decisionIds: ["schema-contract-boundary"],
  minOccurrences: 3,
  minFiles: 1,
  ignore: ["id", "error"],
  message: "Boundary literals should have a canonical owner.",
  docs: ["examples/conventions/docs/opencanon/canon/architecture.md#schemas"],
});

export default validator;
