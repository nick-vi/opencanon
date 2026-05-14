import { sensitiveChangePolicy } from "../../../.agents/skills/opencanon/index.ts";

const validator = sensitiveChangePolicy({
  id: "sensitive-change-requires-decision",
  topics: ["impact", "testing"],
  in: ["src/**/*.{ts,tsx,py}"],
  severity: "warning",
  decisionIds: ["impact-surfaces-current"],
  require: "decision",
  message: "Sensitive impact-surface changes must satisfy the configured change policy.",
  docs: ["examples/conventions/docs/opencanon/canon/impact.md#impact-surfaces"],
});

export default validator;
