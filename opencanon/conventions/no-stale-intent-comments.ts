import { noCommentMatches } from "@opencanon/validators";

const validator = noCommentMatches({
  id: "no-stale-intent-comments",
  title: "Comments do not preserve stale compatibility intent",
  topics: ["comments"],
  in: ["src/**/*.{ts,tsx,py}", "tests/**/*.{ts,tsx,py}"],
  severity: "warning",
  related: ["comments-current"],
  patterns: /\b(backward[-\s]?compat(?:ibility)?|deprecated|legacy|shim)\b/i,
  message: "Comment describes stale compatibility intent.",
  fix: {
    safety: "suggested",
    description: "Refactor the touched flow to the current pattern and remove the stale comment.",
  },
  docs: ["docs/opencanon/canon/no-stale-intent-comments.md#comments-do-not-preserve-stale-compatibility-intent"],
});

export default validator;
