import { duplicateBoundaryLiterals } from "@opencanon/validators";

const validator = duplicateBoundaryLiterals({
  id: "duplicate-boundary-literals",
  title: "Boundary literals have a canonical owner",
  topics: ["maintainability", "schema"],
  in: ["src/api/routes/**/*.{ts,tsx}", "src/contracts/**/*.{ts,tsx}", "packages/*/src/api/routes/**/*.{ts,tsx}", "packages/*/src/contracts/**/*.{ts,tsx}"],
  severity: "warning",
  related: ["schema-contract-boundary"],
  minOccurrences: 3,
  minFiles: 1,
  ignore: ["id", "error"],
  message: "Boundary literals should have a canonical owner.",
  docs: ["docs/opencanon/canon/duplicate-boundary-literals.md#boundary-literals-have-a-canonical-owner"],
});

export default validator;
