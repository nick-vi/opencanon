import { noCommentMatches } from "@opencanon/validators";

const validator = noCommentMatches({
  id: "no-stale-intent-comments",
  topics: ["comments"],
  in: ["src/**/*.{ts,tsx,py}", "tests/**/*.{ts,tsx,py}"],
  severity: "warning",
  decisionIds: ["comments-current"],
  patterns: /\b(backward[-\s]?compat(?:ibility)?|deprecated|legacy|shim)\b/i,
  message: "Comment describes stale compatibility intent.",
  fix: {
    safety: "suggested",
    description: "Refactor the touched flow to the current pattern and remove the stale comment.",
  },
  docs: ["examples/conventions/docs/opencanon/decisions.json#comments-current"],
});

export default validator;
