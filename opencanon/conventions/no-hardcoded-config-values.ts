import { noHardcodedConfigValues } from "@opencanon/validators";

const validator = noHardcodedConfigValues({
  id: "no-hardcoded-config-values",
  title: "Environment config stays behind named settings",
  topics: ["configuration"],
  in: ["src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
  severity: "warning",
  related: ["hardcoded-secrets-and-config"],
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
  allowFiles: ["tests/**", "examples/**", "packages/runtime/test/**"],
  message: "Environment-specific config values should live behind named config.",
  fix: {
    safety: "manual",
    description: "Move the value to a named config object, environment variable, or documented project setting.",
  },
  docs: ["docs/opencanon/canon/no-hardcoded-config-values.md#environment-config-stays-behind-named-settings"],
});

export default validator;
