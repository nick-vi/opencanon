import { sensitiveChangePolicy } from "@opencanon/validators";

const validator = sensitiveChangePolicy({
  id: "sensitive-change-requires-approval",
  title: "Sensitive surface changes require approval",
  topics: ["impact", "testing"],
  in: ["src/**/*.{ts,tsx,py}"],
  severity: "warning",
  related: ["impact-surfaces-current"],
  require: "approval",
  message: "Sensitive impact-surface changes must satisfy the configured change policy.",
  docs: ["docs/opencanon/canon/sensitive-change-requires-approval.md#sensitive-surface-changes-require-approval"],
});

export default validator;
