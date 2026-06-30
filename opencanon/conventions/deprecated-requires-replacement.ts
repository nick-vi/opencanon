import { annotationRequiresTags } from "@opencanon/validators";

const validator = annotationRequiresTags({
  id: "deprecated-requires-replacement",
  title: "Deprecated code names its replacement and removal owner",
  topics: ["hygiene", "lifecycle"],
  in: ["src/**/*.{ts,tsx,py}", "tests/**/*.{ts,tsx,py}"],
  severity: "warning",
  related: ["comments-current"],
  tags: ["deprecated"],
  requireTags: ["owner", "replacement", "remove-by"],
  message: "Deprecated internal code requires owner, replacement, and remove-by metadata.",
  docs: ["docs/opencanon/canon/deprecated-requires-replacement.md#deprecated-code-names-its-replacement-and-removal-owner"],
});

export default validator;
