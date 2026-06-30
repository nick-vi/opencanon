import { noNativeEnums } from "@opencanon/validators";

const validator = noNativeEnums({
  id: "no-native-enums",
  title: "Use const objects instead of native TypeScript enums",
  topics: ["type-patterns"],
  in: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
  severity: "error",
  related: ["const-object-enums"],
  docs: ["docs/opencanon/canon/no-native-enums.md#use-const-objects-instead-of-native-typescript-enums"],
});

export default validator;
