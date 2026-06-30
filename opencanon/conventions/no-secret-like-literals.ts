import { noSecretLikeLiterals } from "@opencanon/validators";

const validator = noSecretLikeLiterals({
  id: "no-secret-like-literals",
  title: "Secret-like literals stay out of source",
  topics: ["security", "configuration"],
  in: ["src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
  severity: "error",
  related: ["hardcoded-secrets-and-config"],
  minLength: 80,
  allow: ["<generated-token>", "test-token", "secret"],
  allowNamedLiterals: [
    {
      in: ["packages/core/src/release-keys.ts"],
      names: ["keyId", "publicKeySpkiBase64"],
    },
  ],
  allowFiles: ["tests/**", "examples/**"],
  message: "Secret-like literals must not be committed.",
  fix: {
    safety: "manual",
    description: "Move the value to a secret manager or environment variable and keep only a named lookup in source.",
  },
  docs: ["docs/opencanon/canon/no-secret-like-literals.md#secret-like-literals-stay-out-of-source"],
});

export default validator;
