import { noShimFiles } from "../../../.agents/skills/opencanon/index.ts";

const validator = noShimFiles({
  id: "no-shim-files",
  topics: ["hygiene", "lifecycle"],
  in: ["src/**/*.{ts,tsx,py}", "tests/**/*.{ts,tsx,py}"],
  severity: "warning",
  decisionIds: ["comments-current"],
  message: "Internal source files should not be named around shims, compatibility, legacy, or deprecated paths.",
  docs: ["examples/conventions/docs/opencanon/canon/lifecycle.md#deprecations"],
});

export default validator;
