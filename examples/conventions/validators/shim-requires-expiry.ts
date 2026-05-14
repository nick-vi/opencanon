import { annotationRequiresTags } from "../../../.agents/skills/opencanon/index.ts";

const validator = annotationRequiresTags({
  id: "shim-requires-expiry",
  topics: ["hygiene", "lifecycle"],
  in: ["src/**/*.{ts,tsx,py}", "tests/**/*.{ts,tsx,py}"],
  severity: "warning",
  decisionIds: ["comments-current"],
  tags: ["shim", "compat", "legacy"],
  requireTags: ["owner", "replacement", "remove-by"],
  message: "Lifecycle shim annotations require owner, replacement, and remove-by metadata.",
  docs: ["examples/conventions/docs/opencanon/canon/lifecycle.md#deprecations"],
});

export default validator;
