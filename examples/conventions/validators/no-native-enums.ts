import { noNativeEnums } from "../../../.agents/skills/opencanon/index.ts";

const validator = noNativeEnums({
  id: "no-native-enums",
  topics: ["type-patterns"],
  in: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
  severity: "error",
  decisionIds: ["const-object-enums"],
  docs: ["examples/conventions/docs/opencanon/decisions.json#const-object-enums"],
});

export default validator;
