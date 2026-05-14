import { noSecretLikeLiterals } from "../../../.agents/skills/opencanon/index.ts";

const validator = noSecretLikeLiterals({
  id: "no-secret-like-literals",
  topics: ["security", "configuration"],
  in: ["src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}", "apps/site/src/**/*.{ts,svelte}"],
  severity: "error",
  decisionIds: ["hardcoded-secrets-and-config"],
  minLength: 80,
  allow: ["<generated-token>", "test-token", "secret"],
  allowFiles: ["tests/**", "examples/**"],
  message: "Secret-like literals must not be committed.",
  fix: {
    safety: "manual",
    description: "Move the value to a secret manager or environment variable and keep only a named lookup in source.",
  },
  docs: ["examples/conventions/docs/opencanon/decisions.json#hardcoded-secrets-and-config"],
});

export default validator;
