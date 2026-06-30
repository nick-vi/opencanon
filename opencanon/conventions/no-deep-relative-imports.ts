import { noDeepRelativeImports } from "@opencanon/validators";

const validator = noDeepRelativeImports({
  id: "no-deep-relative-imports",
  title: "Imports avoid deep relative parent climbs",
  topics: ["imports"],
  in: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
  severity: "warning",
  related: ["import-boundaries-current"],
  maxDepth: 1,
  message: "Deep relative import crosses too many ownership levels.",
  fix: {
    safety: "suggested",
    description: "Use an approved alias/barrel or move the helper closer to the importing code.",
  },
  docs: ["docs/opencanon/canon/no-deep-relative-imports.md#imports-avoid-deep-relative-parent-climbs"],
});

export default validator;
