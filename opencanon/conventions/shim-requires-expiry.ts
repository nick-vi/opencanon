import { annotationRequiresTags } from "@opencanon/validators";

const validator = annotationRequiresTags({
  id: "shim-requires-expiry",
  title: "Shim annotations declare owner, replacement, and removal date",
  topics: ["hygiene", "lifecycle"],
  in: ["src/**/*.{ts,tsx,py}", "tests/**/*.{ts,tsx,py}"],
  severity: "warning",
  related: ["comments-current"],
  tags: ["shim", "compat", "legacy"],
  requireTags: ["owner", "replacement", "remove-by"],
  message: "Lifecycle shim annotations require owner, replacement, and remove-by metadata.",
  docs: ["docs/opencanon/canon/shim-requires-expiry.md#shim-annotations-declare-owner-replacement-and-removal-date"],
});

export default validator;
