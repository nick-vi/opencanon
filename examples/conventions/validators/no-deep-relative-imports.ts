import { noDeepRelativeImports } from "@opencanon/validators";

const validator = noDeepRelativeImports({
  id: "no-deep-relative-imports",
  topics: ["imports"],
  in: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
  severity: "warning",
  decisionIds: ["import-boundaries-current"],
  maxDepth: 1,
  message: "Deep relative import crosses too many ownership levels.",
  fix: {
    safety: "suggested",
    description: "Use an approved alias/barrel or move the helper closer to the importing code.",
  },
  docs: ["examples/conventions/docs/opencanon/decisions.json#import-boundaries-current"],
});

export default validator;
