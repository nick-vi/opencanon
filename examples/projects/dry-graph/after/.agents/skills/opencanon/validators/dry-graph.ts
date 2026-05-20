import { repeatedLiterals, similarFunctionNames } from "../index.ts";

export default [
  repeatedLiterals({
    id: "repeated-domain-literals",
    topics: ["dry", "domain-model"],
    in: ["src/**/*.ts"],
    severity: "warning",
    minOccurrences: 2,
    minFiles: 1,
    message: "Repeated domain literals should be extracted.",
    docs: ["docs/opencanon/canon/dry.md#graph-backed-dry"],
  }),
  similarFunctionNames({
    id: "similar-functions",
    topics: ["dry", "code-quality"],
    in: ["src/**/*.ts"],
    severity: "warning",
    requireSharedCallees: true,
    message: "Similar function surfaces may duplicate behavior.",
    docs: ["docs/opencanon/canon/dry.md#graph-backed-dry"],
  }),
];
