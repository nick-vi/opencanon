import { noHardcodedConfigValues } from "@opencanon/validators";

const validator = noHardcodedConfigValues({
  id: "no-hardcoded-config-values",
  topics: ["configuration"],
  in: ["src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}", "apps/site/src/**/*.{ts,svelte}"],
  severity: "warning",
  decisionIds: ["hardcoded-secrets-and-config"],
  kinds: ["url", "host"],
  allow: [
    "http://127.0.0.1:4767",
    "http://127.0.0.1",
    "http://localhost",
    "http://www.w3.org/2000/svg",
    "127.0.0.1",
    "localhost",
    "https://github.com/opencanon/opencanon",
    "https://github.com/opencanon/opencanon/releases/download/v0.1.0/opencanon-runtime-manifest.json",
  ],
  allowFiles: ["tests/**", "examples/**", "packages/daemon/test/**"],
  message: "Environment-specific config values should live behind named config.",
  fix: {
    safety: "manual",
    description: "Move the value to a named config object, environment variable, or documented project setting.",
  },
  docs: ["examples/conventions/docs/opencanon/decisions.json#hardcoded-secrets-and-config"],
});

export default validator;
