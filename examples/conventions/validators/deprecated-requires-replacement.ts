import { annotationRequiresTags } from "@opencanon/validators";

const validator = annotationRequiresTags({
  id: "deprecated-requires-replacement",
  topics: ["hygiene", "lifecycle"],
  in: ["src/**/*.{ts,tsx,py}", "tests/**/*.{ts,tsx,py}"],
  severity: "warning",
  decisionIds: ["comments-current"],
  tags: ["deprecated"],
  requireTags: ["owner", "replacement", "remove-by"],
  message: "Deprecated internal code requires owner, replacement, and remove-by metadata.",
  docs: ["examples/conventions/docs/opencanon/canon/lifecycle.md#deprecations"],
});

export default validator;
